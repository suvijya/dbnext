import * as vscode from 'vscode';
import type { EngineHint, FileResult, ScanWarning, SchemaModel, SourceKind } from '../core/model';
import { buildModel } from '../core/resolve';
import {
  DEFAULT_EXCLUDES,
  decodeText,
  globGroup,
  globToRegExp,
  includePatterns,
  parseFile,
  pathPriority,
  priorityPatterns,
  type FileParseOutcome,
  type ParserRegistry,
} from '../core/scan';
import type { DbNextConfig } from './config';
import type { Log } from './log';

export interface ScanOutput {
  model: SchemaModel;
  /** `SourceRef.file` (workspace-relative path) → URI of every file that was read. */
  uris: Map<string, vscode.Uri>;
}

interface CacheEntry {
  rel: string;
  mtime: number;
  size: number;
  outcome: FileParseOutcome;
}

interface Candidate {
  uri: vscode.Uri;
  rel: string;
  priority: number;
}

interface FileOutcome extends FileParseOutcome {
  uri: vscode.Uri;
  rel: string;
}

const CONCURRENCY = 16;
const EMPTY_OUTCOME: FileParseOutcome = { results: [], hints: [], errors: [] };

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Glob patterns excluded from scanning: built-in defaults plus user settings. */
export function excludePatterns(config: DbNextConfig): string[] {
  return [...DEFAULT_EXCLUDES, ...config.exclude];
}

/** Matches workspace-relative paths that must be ignored (used for file-watcher events). */
export function excludeMatcher(config: DbNextConfig): RegExp {
  return globToRegExp(excludePatterns(config).flatMap((p) => (p.endsWith('/**') ? [p] : [p, `${p}/**`])));
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Finds, reads and parses schema files. Parse results are cached per file (keyed by URI and
 * validated by mtime/size), so rescans after a file change only re-parse what changed.
 */
export class Scanner {
  private cache = new Map<string, CacheEntry>();
  private dirty = new Set<string>();

  constructor(
    private readonly registry: ParserRegistry,
    private readonly log: Log,
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    this.cache.delete(key);
    this.dirty.add(key);
  }

  /** Scans every workspace folder. Resolves to `undefined` when cancelled. */
  async scan(config: DbNextConfig, token: vscode.CancellationToken, progress?: (message: string) => void): Promise<ScanOutput | undefined> {
    const started = Date.now();
    this.dirty = new Set();
    const warnings: ScanWarning[] = [];

    const found = await this.findCandidates(config, token);
    if (!found) return undefined;
    const { candidates, hitCap } = found;
    const truncated = hitCap || candidates.length > config.maxFiles;
    const selected = candidates.slice(0, config.maxFiles);
    if (truncated) {
      warnings.push({
        message: `The workspace has more than ${config.maxFiles} candidate files; only the ${config.maxFiles} most relevant were scanned. Raise "dbnext.maxFiles" to scan more.`,
      });
    }

    const nextCache = new Map<string, CacheEntry>();
    const outcomes = await this.readAll(selected, config, token, nextCache, warnings, progress);
    if (!outcomes) return undefined;
    for (const key of this.dirty) nextCache.delete(key); // changed while this scan was running
    this.cache = nextCache;

    const results: FileResult[] = [];
    const engineHints: { file: string; hint: EngineHint }[] = [];
    const uris = new Map<string, vscode.Uri>();
    let filesRead = 0;
    let filesParsed = 0;
    for (const o of outcomes) {
      if (!o) continue;
      filesRead++;
      uris.set(o.rel, o.uri);
      if (o.results.length) filesParsed++;
      results.push(...o.results);
      for (const hint of o.hints) engineHints.push({ file: o.rel, hint });
      // Parser-crash errors become scan warnings; the controller logs them (once, truncated and
      // capped) after the scan. Logging them again here only duplicated the output on visible scans
      // and spammed the channel on every background rescan.
      for (const error of o.errors) warnings.push({ file: o.rel, message: error });
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const model = buildModel({
      workspaceName: vscode.workspace.name ?? folders[0]?.name ?? 'workspace',
      results,
      engineHints,
      warnings,
      inferRelations: config.inferRelations,
      stats: { filesFound: candidates.length, filesRead, filesParsed, durationMs: Date.now() - started, truncated },
    });
    return { model, uris };
  }

  private async findCandidates(config: DbNextConfig, token: vscode.CancellationToken) {
    const exclude = globGroup(excludePatterns(config));
    const include = globGroup(includePatterns(this.registry));
    const priority = globGroup(priorityPatterns(this.registry));
    const cap = Math.min(Math.max(config.maxFiles * 4, 2000), 200_000);
    const found = new Map<string, Candidate>();
    let hitCap = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const glob of [priority, include]) {
        if (!glob) continue;
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), exclude || undefined, cap, token);
        if (token.isCancellationRequested) return undefined;
        if (glob === include && uris.length >= cap) hitCap = true;
        for (const uri of uris) {
          const key = uri.toString();
          if (found.has(key)) continue;
          const rel = vscode.workspace.asRelativePath(uri);
          found.set(key, { uri, rel, priority: pathPriority(rel) });
        }
      }
    }
    const candidates = [...found.values()].sort(
      (a, b) => b.priority - a.priority || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
    );
    return { candidates, hitCap };
  }

  private async readAll(
    selected: readonly Candidate[],
    config: DbNextConfig,
    token: vscode.CancellationToken,
    nextCache: Map<string, CacheEntry>,
    warnings: ScanWarning[],
    progress?: (message: string) => void,
  ): Promise<(FileOutcome | undefined)[] | undefined> {
    const disabled = new Set<SourceKind>(config.disabledSources);
    const maxBytes = config.maxFileSizeKB * 1024;
    const outcomes: (FileOutcome | undefined)[] = new Array(selected.length);
    let next = 0;
    let done = 0;
    let lastYield = Date.now();

    const worker = async () => {
      while (next < selected.length && !token.isCancellationRequested) {
        const i = next++;
        const c = selected[i];
        const key = c.uri.toString();
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(c.uri);
        } catch {
          continue; // deleted since the search
        }
        if (stat.type & vscode.FileType.Directory) continue;
        if (stat.size > maxBytes) {
          if (c.priority > 0) {
            warnings.push({
              file: c.rel,
              message: `Skipped: larger than the ${config.maxFileSizeKB} KB limit (${formatSize(stat.size)}). Raise "dbnext.maxFileSizeKB" to include it.`,
            });
          }
          continue;
        }
        const cached = this.cache.get(key);
        let outcome: FileParseOutcome;
        if (cached && cached.rel === c.rel && cached.mtime === stat.mtime && cached.size === stat.size) {
          outcome = cached.outcome;
        } else {
          let bytes: Uint8Array;
          try {
            bytes = await vscode.workspace.fs.readFile(c.uri);
          } catch (e) {
            this.log.warn(`Could not read ${c.rel}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          const text = decodeText(bytes);
          outcome = text === undefined ? EMPTY_OUTCOME : parseFile({ path: c.rel, text }, this.registry, disabled);
        }
        nextCache.set(key, { rel: c.rel, mtime: stat.mtime, size: stat.size, outcome });
        outcomes[i] = { ...outcome, uri: c.uri, rel: c.rel };
        done++;
        if (progress && done % 200 === 0) progress(`${done} / ${selected.length} files`);
        if (Date.now() - lastYield > 25) {
          await yieldToEventLoop(); // keep the extension host responsive
          lastYield = Date.now();
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));
    return token.isCancellationRequested ? undefined : outcomes;
  }
}
