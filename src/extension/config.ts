import * as vscode from 'vscode';
import { SOURCE_KINDS, type SourceKind } from '../core/model';
import { sanitizeExportPath } from '../core/scan';

export type AutoOpen = 'firstTime' | 'always' | 'never';

/** Validated snapshot of the `dbnext.*` settings. */
export interface DbNextConfig {
  autoOpen: AutoOpen;
  inferRelations: boolean;
  /** `dbnext.exclude` plus the enabled entries of `files.exclude`. */
  exclude: string[];
  disabledSources: SourceKind[];
  maxFiles: number;
  maxFileSizeKB: number;
  watch: boolean;
  statusBar: boolean;
  /** Workspace-relative, sanitized path of the Markdown export. */
  exportPath: string;
  exportAutoUpdate: boolean;
}

/** Settings whose change requires a new scan. */
export const SCAN_SETTINGS: readonly string[] = [
  'dbnext.inferRelations',
  'dbnext.exclude',
  'dbnext.disabledSources',
  'dbnext.maxFiles',
  'dbnext.maxFileSizeKB',
  'files.exclude',
];

/** Settings whose change invalidates cached parse results. */
export const CACHE_SETTINGS: readonly string[] = ['dbnext.disabledSources', 'dbnext.maxFileSizeKB'];

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function filesExclude(): string[] {
  const value = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {};
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([glob]) => glob);
}

export function readConfig(): DbNextConfig {
  const c = vscode.workspace.getConfiguration('dbnext');
  const autoOpen = c.get<string>('autoOpen');
  const known = new Set<string>(SOURCE_KINDS);
  return {
    autoOpen: autoOpen === 'always' || autoOpen === 'never' ? autoOpen : 'firstTime',
    inferRelations: c.get<boolean>('inferRelations') !== false,
    exclude: [...strings(c.get('exclude')), ...filesExclude()],
    disabledSources: strings(c.get('disabledSources')).filter((s): s is SourceKind => known.has(s)),
    maxFiles: int(c.get('maxFiles'), 100, 200_000, 5000),
    maxFileSizeKB: int(c.get('maxFileSizeKB'), 16, 1_048_576, 2048),
    watch: c.get<boolean>('watch') !== false,
    statusBar: c.get<boolean>('statusBar') !== false,
    exportPath: sanitizeExportPath(c.get('export.path')),
    exportAutoUpdate: c.get<boolean>('export.autoUpdate') === true,
  };
}
