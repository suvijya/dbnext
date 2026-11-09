import * as vscode from 'vscode';
import type { EngineHint, FileResult, SchemaModel } from '../core/model';
import { buildModel } from '../core/resolve';
import { decodeText, globToRegExp, includePatterns, parseFile, type ParserRegistry } from '../core/scan';
import type { DbNextConfig } from './config';
import { excludeMatcher, type Scanner } from './scanner';

/** The subset of the built-in `vscode.git` extension API (v1) used here. */
interface GitRef {
  readonly type: number; // 0 = head, 1 = remote head, 2 = tag
  readonly name?: string;
  readonly commit?: string;
}
interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
}
interface GitCommit {
  readonly hash: string;
  readonly message: string;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  getRefs(query?: { count?: number }): Promise<GitRef[]>;
  buffer(ref: string, path: string): Promise<Uint8Array>;
  diffWith(ref: string): Promise<GitChange[]>;
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}
interface GitApi {
  readonly repositories: GitRepository[];
}

export const WORKING_TREE = 'Working tree';

/** Resolves the git API. Fails with a readable message on the web host or when git is disabled. */
export async function getGit(): Promise<GitApi> {
  if (vscode.env.uiKind === vscode.UIKind.Web) throw new Error('comparing with a git ref needs the desktop version of VS Code.');
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!ext) throw new Error('the built-in Git extension is not available.');
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

async function pickRepository(git: GitApi): Promise<GitRepository | undefined> {
  const repos = git.repositories;
  if (!repos.length) throw new Error('this workspace is not a git repository.');
  if (repos.length === 1) return repos[0];
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri, true), repo: r })),
    { placeHolder: 'Select the git repository' },
  );
  return pick?.repo;
}

/** Quick pick over branches, tags and recent commits. `allowWorkingTree` adds a "Working tree" entry. */
export async function pickRef(repo: GitRepository, placeHolder: string, allowWorkingTree: boolean): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { ref?: string; custom?: boolean };
  const items: Item[] = [];
  if (allowWorkingTree) items.push({ label: WORKING_TREE, description: 'current files on disk', ref: WORKING_TREE });
  const [refs, commits] = await Promise.all([repo.getRefs({}).catch(() => [] as GitRef[]), repo.log({ maxEntries: 20 }).catch(() => [] as GitCommit[])]);
  const kind = (t: number) => (t === 2 ? 'tag' : t === 1 ? 'remote branch' : 'branch');
  const named = refs.filter((r) => r.name).sort((a, b) => a.type - b.type || (a.name! < b.name! ? -1 : 1));
  if (named.length) items.push({ label: 'Branches and tags', kind: vscode.QuickPickItemKind.Separator });
  for (const r of named) items.push({ label: r.name!, description: kind(r.type), ref: r.name });
  if (commits.length) items.push({ label: 'Recent commits', kind: vscode.QuickPickItemKind.Separator });
  for (const c of commits) items.push({ label: c.hash.slice(0, 8), description: c.message.split('\n')[0], ref: c.hash });
  items.push({ label: '$(edit) Enter a ref or commit…', custom: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  if (!pick) return undefined;
  if (pick.custom) return (await vscode.window.showInputBox({ prompt: 'Branch, tag, commit hash or expression such as HEAD~3' }))?.trim() || undefined;
  return pick.ref;
}

/** Lets the user choose a repository and the two sides of the comparison. */
export async function pickComparison(): Promise<{ repo: GitRepository; base: string; head: string } | undefined> {
  const git = await getGit();
  const repo = await pickRepository(git);
  if (!repo) return undefined;
  const base = await pickRef(repo, 'Compare against… (older version)', false);
  if (!base) return undefined;
  const head = await pickRef(repo, `Compare ${base} with… (newer version)`, true);
  if (!head) return undefined;
  return { repo, base, head };
}

function relativeToRepo(repo: GitRepository, uri: vscode.Uri): string | undefined {
  const root = repo.rootUri.path.replace(/\/+$/, '');
  const path = uri.path;
  if (path.length <= root.length + 1 || path.slice(0, root.length).toLowerCase() !== root.toLowerCase() || path[root.length] !== '/') return undefined;
  return path.slice(root.length + 1);
}

/**
 * Builds the schema model of the files as they were at `ref`, without touching the working tree:
 * file contents come from `git show`-style blob reads; the parse pipeline is the regular pure one.
 * Candidates are the files found in the workspace now plus the files that differ between `ref`
 * and the working tree (so files that were deleted since `ref` are still seen).
 */
export async function scanAtRef(
  repo: GitRepository,
  ref: string,
  scanner: Scanner,
  registry: ParserRegistry,
  config: DbNextConfig,
  token: vscode.CancellationToken,
  workspaceName: string,
): Promise<SchemaModel | undefined> {
  const started = Date.now();
  const found = await scanner.findCandidates(config, token);
  if (!found || token.isCancellationRequested) return undefined;

  const candidates = new Map<string, vscode.Uri>();
  for (const c of found.candidates) candidates.set(c.uri.toString(), c.uri);
  const include = globToRegExp(includePatterns(registry));
  const excluded = excludeMatcher(config);
  for (const change of await repo.diffWith(ref)) {
    for (const uri of [change.uri, change.originalUri]) {
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (include.test(rel) && !excluded.test(rel)) candidates.set(uri.toString(), uri);
    }
  }

  const disabled = new Set(config.disabledSources);
  const maxBytes = config.maxFileSizeKB * 1024;
  const list = [...candidates.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const results: FileResult[] = [];
  const hints: { file: string; hint: EngineHint }[] = [];
  const warnings: { file?: string; message: string }[] = [];
  let filesRead = 0;
  let filesParsed = 0;
  let next = 0;

  const worker = async () => {
    while (next < list.length && !token.isCancellationRequested) {
      const uri = list[next++];
      const path = relativeToRepo(repo, uri);
      if (path === undefined) continue;
      let bytes: Uint8Array;
      try {
        bytes = await repo.buffer(ref, path);
      } catch {
        continue; // the file did not exist at that ref
      }
      if (bytes.byteLength > maxBytes) continue;
      const text = decodeText(bytes);
      if (text === undefined) continue;
      const rel = vscode.workspace.asRelativePath(uri);
      const outcome = parseFile({ path: rel, text }, registry, disabled);
      filesRead++;
      if (outcome.results.length) filesParsed++;
      results.push(...outcome.results);
      for (const hint of outcome.hints) hints.push({ file: rel, hint });
      for (const error of outcome.errors) warnings.push({ file: rel, message: error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  if (token.isCancellationRequested) return undefined;

  // Parse results arrive in worker order; the resolver replays migrations by path, so sort for stability.
  results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return buildModel({
    workspaceName,
    results,
    engineHints: hints,
    warnings,
    inferRelations: config.inferRelations,
    stats: { filesFound: list.length, filesRead, filesParsed, durationMs: Date.now() - started, truncated: false },
  });
}
