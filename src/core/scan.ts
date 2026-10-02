/**
 * Scanner helpers that do not depend on VS Code: default excludes, glob handling, file
 * prioritisation, text decoding and running the registered parsers on one file.
 */

import type { EngineHint, FileResult, ParseResult, SourceFile, SourceKind } from './model';
import { extOf, pathSegments, type SchemaParser } from './parser';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Registry contract
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Finds database engines in configuration files (docker compose, dependency manifests, env examples…). */
export interface EngineDetector {
  /** Workspace-relative glob patterns of files worth inspecting, e.g. `**∕docker-compose*.yml`. */
  readonly filePatterns: readonly string[];
  /** Whether a workspace-relative path (forward slashes) should be passed to `detect`. */
  matches(path: string): boolean;
  /** Never returns secrets: details name the evidence (`image "postgres:16"`), not credentials. */
  detect(file: SourceFile): EngineHint[];
}

export interface ParserRegistry {
  readonly parsers: readonly SchemaParser[];
  readonly engines: EngineDetector;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Globs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Folders and files that never contain a project's own schema (dependencies, build output, caches). */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/bin/**',
  '**/obj/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/site-packages/**',
  '**/.tox/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.output/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.gradle/**',
  '**/.idea/**',
  '**/.vs/**',
  '**/Pods/**',
  '**/DerivedData/**',
  '**/.dart_tool/**',
  '**/deps/**',
  '**/_build/**',
  '**/.elixir_ls/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/.terraform/**',
  '**/.vscode-test/**',
  '**/storage/framework/**',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/__snapshots__/**',
  '**/test/**',
  '**/tests/**',
  '**/spec/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/src/test/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.down.sql',
  '**/down.sql',
  '**/*.Designer.cs',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
];

/** Expands brace groups (`**∕*.{ts,js}` → two patterns). Supports nesting; `\{` escapes. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === '}' && depth > 0 && --depth === 0) {
      const body = pattern.slice(start + 1, i);
      const options: string[] = [];
      let d = 0;
      let seg = 0;
      for (let j = 0; j < body.length; j++) {
        const b = body[j];
        if (b === '\\') j++;
        else if (b === '{') d++;
        else if (b === '}') d--;
        else if (b === ',' && d === 0) {
          options.push(body.slice(seg, j));
          seg = j + 1;
        }
      }
      options.push(body.slice(seg));
      const head = pattern.slice(0, start);
      const tails = expandBraces(pattern.slice(i + 1));
      const out: string[] = [];
      for (const o of options) for (const e of expandBraces(o)) for (const t of tails) out.push(head + e + t);
      return out;
    }
  }
  return [pattern];
}

/**
 * Combines patterns into ONE brace group for `workspace.findFiles` / file watchers.
 * VS Code globs do not support nested braces, so every pattern is expanded first.
 */
export function globGroup(patterns: readonly string[]): string {
  const flat = [...new Set(patterns.flatMap((p) => expandBraces(p.trim())).filter(Boolean))];
  if (flat.length === 0) return '';
  return flat.length === 1 ? flat[0] : `{${flat.join(',')}}`;
}

function segmentToRegExp(p: string): string {
  let s = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          s += '(?:.*/)?';
          i += 2;
        } else {
          s += '.*';
          i += 1;
        }
      } else {
        s += '[^/]*';
      }
    } else if (c === '?') {
      s += '[^/]';
    } else if (c === '[') {
      const j = p.indexOf(']', i + 2);
      if (j < 0) {
        s += '\\[';
        continue;
      }
      let cls = p.slice(i + 1, j);
      if (cls[0] === '!') cls = `^${cls.slice(1)}`;
      s += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = j;
    } else if (c === '\\' && i + 1 < p.length) {
      s += `\\${p[++i]}`;
    } else {
      s += /[.+^${}()|\\/]/.test(c) ? `\\${c}` : c;
    }
  }
  return s;
}

/** Case-insensitive RegExp for a VS Code style glob (`**`, `*`, `?`, `[…]`, `{a,b}`) over relative paths. */
export function globToRegExp(patterns: string | readonly string[]): RegExp {
  const list = (typeof patterns === 'string' ? [patterns] : patterns).flatMap((p) => expandBraces(p.trim())).filter(Boolean);
  if (!list.length) return /$^/;
  return new RegExp(`^(?:${list.map(segmentToRegExp).join('|')})$`, 'i');
}

/** Include glob of every file the parsers or the engine detector may care about. */
export function includePatterns(registry: ParserRegistry): string[] {
  return [
    ...parserExtensions(registry).map((e) => `**/*.${e}`),
    ...restrictedPatterns(registry),
    ...registry.engines.filePatterns,
  ];
}

/** Extensions of parsers that accept every file of their extensions (no `filePatterns`). */
function parserExtensions(registry: ParserRegistry): string[] {
  const exts = new Set<string>();
  for (const p of registry.parsers) {
    if (p.filePatterns?.length) continue;
    for (const e of p.extensions) exts.add(e.replace(/^\./, '').toLowerCase());
  }
  return [...exts].sort();
}

/** `filePatterns` of parsers that only want specific files. */
function restrictedPatterns(registry: ParserRegistry): string[] {
  return [...new Set(registry.parsers.flatMap((p) => p.filePatterns ?? []))];
}

const STRONG_FILE_PATTERNS = [
  '**/*.prisma',
  '**/*.dbml',
  '**/*.sql',
  '**/schema.rb',
  '**/models.py',
  '**/schema.rs',
  '**/*.{entity,model,schema}.{ts,js,mts,cts,mjs,cjs}',
  '**/schema.{ts,js}',
  '**/*DbContext.cs',
  '**/*ModelSnapshot.cs',
];

const PRIORITY_DIRS = [
  'models',
  'Models',
  'model',
  'entities',
  'entity',
  'Entities',
  'schema',
  'schemas',
  'migrations',
  'Migrations',
  'migrate',
  'db',
  'database',
  'prisma',
  'drizzle',
  'persistence',
  'domain',
  'alembic',
];

/**
 * Patterns of files that very likely hold schema definitions. They are searched separately so
 * that schema files are never lost when a huge repository exceeds the file limit.
 */
export function priorityPatterns(registry: ParserRegistry): string[] {
  const exts = parserExtensions(registry);
  const restricted = restrictedPatterns(registry);
  if (!exts.length) return [...restricted, ...registry.engines.filePatterns];
  const known = new Set(exts);
  const extGroup = exts.length === 1 ? exts[0] : `{${exts.join(',')}}`;
  const strong = STRONG_FILE_PATTERNS.filter((p) =>
    expandBraces(p).some((x) => known.has(x.slice(x.lastIndexOf('.') + 1).toLowerCase())),
  );
  return [...strong, `**/{${PRIORITY_DIRS.join(',')}}/**/*.${extGroup}`, ...restricted, ...registry.engines.filePatterns];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Prioritisation
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STRONG_NAMES =
  /^(?:schema\.prisma|.*\.prisma|schema\.rb|structure\.sql|schema\.sql|.*\.dbml|models\.py|schema\.rs|.*\.entity\.[cm]?[jt]sx?|.*\.model\.[cm]?[jt]sx?|.*\.schema\.[cm]?[jt]sx?|schema\.[cm]?[jt]s|.*dbcontext\.cs|.*modelsnapshot\.cs|.*\.cql)$/i;

const HINT_SEGMENTS = new Set([
  'models',
  'model',
  'entities',
  'entity',
  'schema',
  'schemas',
  'migrations',
  'migration',
  'migrate',
  'db',
  'database',
  'databases',
  'prisma',
  'drizzle',
  'domain',
  'persistence',
  'orm',
  'sql',
  'ddl',
  'alembic',
  'repo',
]);

const LOW_SEGMENTS = /^(?:test|tests|__tests__|spec|specs|e2e|fixtures?|__fixtures__|__mocks__|testdata|examples?|samples?|docs?|demo|benchmarks?)$/;

/** Higher = more likely to contain schema definitions. Used to decide what to read first / keep when truncating. */
export function pathPriority(path: string): number {
  const segs = pathSegments(path);
  const base = segs[segs.length - 1] ?? '';
  let score = 0;
  if (STRONG_NAMES.test(base)) score += 10;
  if (extOf(path) === '.sql') score += 3;
  if (segs.slice(0, -1).some((s) => HINT_SEGMENTS.has(s))) score += 5;
  if (segs.slice(0, -1).some((s) => LOW_SEGMENTS.test(s))) score -= 6;
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading and parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Decodes file bytes (UTF-8, UTF-16 with or without a BOM). Returns `undefined` for binary content. */
export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return noNul(new TextDecoder('utf-16le').decode(bytes));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return noNul(new TextDecoder('utf-16be').decode(bytes));
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('\u0000')) return utf8;
    // Embedded NUL: likely UTF-16 saved without a BOM (common for SQL Server / Windows tools).
    const enc = detectUtf16(bytes);
    if (enc) return noNul(new TextDecoder(enc).decode(bytes));
    return undefined;
  } catch {
    return undefined;
  }
}

function noNul(text: string): string | undefined {
  return text.includes('\u0000') ? undefined : text;
}

/**
 * Detects BOM-less UTF-16 from its NUL-byte pattern: ASCII code points store their high byte as
 * `0x00`, at odd offsets for little-endian and even offsets for big-endian.
 */
function detectUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const n = Math.min(bytes.length - (bytes.length % 2), 4096);
  const pairs = n / 2;
  if (pairs < 4) return undefined; // too little to tell text from binary (e.g. a short file header)
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  // Text is one-sided: almost every code unit has a zero high byte; binary scatters its NULs.
  if (oddZero > pairs * 0.7 && evenZero < pairs * 0.3) return 'utf-16le';
  if (evenZero > pairs * 0.7 && oddZero < pairs * 0.3) return 'utf-16be';
  return undefined;
}

export interface FileParseOutcome {
  results: FileResult[];
  hints: EngineHint[];
  /** Parser crashes (bugs) – reported as scan warnings. */
  errors: string[];
}

function hasOutput(r: ParseResult | undefined): r is ParseResult {
  return !!r && !!(r.entities?.length || r.relations?.length || r.enums?.length || r.ops?.length || r.engines?.length || r.warnings?.length);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const patternCache = new WeakMap<SchemaParser, RegExp>();

/** Whether `path` passes the parser's optional `filePatterns` restriction. */
function wantsPath(parser: SchemaParser, path: string): boolean {
  if (!parser.filePatterns?.length) return true;
  let re = patternCache.get(parser);
  if (!re) patternCache.set(parser, (re = globToRegExp(parser.filePatterns)));
  return re.test(path);
}

/** Runs every applicable parser (and the engine detector) on one file. Never throws. */
export function parseFile(file: SourceFile, registry: ParserRegistry, disabled: ReadonlySet<SourceKind> = new Set()): FileParseOutcome {
  const out: FileParseOutcome = { results: [], hints: [], errors: [] };
  const ext = extOf(file.path);
  for (const parser of registry.parsers) {
    if (disabled.has(parser.kind) || !parser.extensions.includes(ext) || !wantsPath(parser, file.path)) continue;
    let applies = false;
    try {
      applies = parser.detect(file);
    } catch (e) {
      out.errors.push(`${parser.kind} detector failed: ${message(e)}`);
    }
    if (!applies) continue;
    try {
      const result = parser.parse(file);
      if (hasOutput(result)) out.results.push({ file: file.path, kind: parser.kind, result });
    } catch (e) {
      out.errors.push(`${parser.kind} parser failed: ${message(e)}`);
    }
  }
  try {
    if (registry.engines.matches(file.path)) out.hints.push(...registry.engines.detect(file));
  } catch (e) {
    out.errors.push(`engine detection failed: ${message(e)}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Keeps a user-provided export path inside the workspace: absolute paths and `..` segments fall
 * back to `DBMAP.md`, backslashes become slashes and a `.md` extension is added when missing.
 */
export function sanitizeExportPath(value: unknown): string {
  const fallback = 'DBMAP.md';
  if (typeof value !== 'string') return fallback;
  const p = value.trim().replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) return fallback;
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.some((s) => s === '..')) return fallback;
  const clean = segments.join('/');
  return /\.(md|markdown|mdx)$/i.test(clean) ? clean : `${clean}.md`;
}

/**
 * Relative link from a directory to a file, both given as absolute URI paths (`/c:/repo/docs`, `/c:/repo/db/schema.sql`
 * → `../db/schema.sql`). Segments are compared case-insensitively when `ignoreCase` is set.
 */
export function relativePath(fromDir: string, to: string, ignoreCase = false): string {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  const eq = (x: string, y: string) => (ignoreCase ? x.toLowerCase() === y.toLowerCase() : x === y);
  // Different Windows drive letters have no common relative route; keep the absolute target.
  const drive = /^[a-zA-Z]:$/;
  if (a.length && b.length && drive.test(a[0]) && drive.test(b[0]) && a[0].toLowerCase() !== b[0].toLowerCase()) return to;
  let i = 0;
  while (i < a.length && i < b.length - 1 && eq(a[i], b[i])) i++;
  const rel = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  return rel || '.';
}
