/**
 * Shared, dependency-free helpers for the JavaScript / TypeScript schema parsers
 * (TypeORM, MikroORM, Drizzle, Knex, Kysely).
 *
 * Everything here works on a {@link Code} lexed with `lang: 'js'`: structure is searched in
 * `code.masked` (comments and string *contents* blanked, brackets/quotes kept) and values are read
 * from `code.stripped` via `code.span(...)`. Pure TypeScript, no Node APIs.
 */

import { cleanComment, Code, stringValue } from '../../core/text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Character helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
}

export function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/** Reads an identifier (`[\w$]+`) starting at `i` of the masked text, `''` when none. */
export function identAt(m: string, i: number): string {
  let j = i;
  while (j < m.length && isIdentChar(m[j])) j++;
  return m.slice(i, j);
}

/** Last `.`-separated segment of a (possibly qualified) name: `typeorm.Entity` → `Entity`. */
export function lastSegment(name: string): string {
  const parts = name.split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

function skipWsFwd(m: string, i: number, limit: number): number {
  while (i < limit && isSpace(m[i])) i++;
  return i;
}

function skipWsBack(m: string, i: number): number {
  while (i >= 0 && isSpace(m[i])) i--;
  return i;
}

/** Offset of the open bracket matching the closing bracket at `close` (same kind), or -1. */
export function matchBackward(m: string, close: number): number {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const open = pairs[m[close]];
  if (!open) return -1;
  const c = m[close];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (m[i] === c) depth++;
    else if (m[i] === open && --depth === 0) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Module specifiers of every `import`/`export … from '…'` and `require('…')` in the file. */
export function moduleSpecifiers(code: Code): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of code.masked.matchAll(re)) {
    // The capture groups blank the string content in `masked`; read the real specifier from text.
    const slice = code.text.slice(m.index, m.index + m[0].length);
    const sm = /['"]([^'"]+)['"]/.exec(slice);
    if (sm) out.push(sm[1]);
    else out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out.filter(Boolean);
}

/** Cheap raw-text check for a `from '<module>'` / `require('<module>')` import (used by `detect`). */
export function importsFrom(text: string, module: RegExp): boolean {
  const re = new RegExp(`(?:from|require\\s*\\(|import)\\s*['"]${module.source}['"]`);
  return re.test(text);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Decorators
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Decorator {
  /** Last segment of the decorator name (`PrimaryGeneratedColumn`, `Entity`, …). */
  name: string;
  /** Offset of the opening `(` of its arguments, or -1 when the decorator has none. */
  open: number;
  line: number;
}

const MODIFIERS = new Set([
  'export',
  'default',
  'abstract',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'override',
  'declare',
  'async',
  'get',
  'set',
]);

/** Decorators attached to the declaration whose first token starts at `pos`, scanning backwards. */
export function decoratorsBefore(code: Code, pos: number): Decorator[] {
  const m = code.masked;
  const out: Decorator[] = [];
  let i = pos - 1;
  for (;;) {
    i = skipWsBack(m, i);
    if (i < 0) break;
    if (m[i] === ')') {
      const open = matchBackward(m, i);
      if (open < 0) break;
      let k = skipWsBack(m, open - 1);
      const nameEnd = k + 1;
      while (k >= 0 && (isIdentChar(m[k]) || m[k] === '.')) k--;
      if (m[k] !== '@') break;
      out.unshift({ name: lastSegment(m.slice(k + 1, nameEnd)), open, line: code.lineAt(k) });
      i = k - 1;
    } else if (isIdentChar(m[i]) || m[i] === '.') {
      let k = i;
      while (k >= 0 && (isIdentChar(m[k]) || m[k] === '.')) k--;
      const word = m.slice(k + 1, i + 1);
      if (m[k] === '@') {
        out.unshift({ name: lastSegment(word), open: -1, line: code.lineAt(k) });
        i = k - 1;
      } else if (MODIFIERS.has(word)) {
        i = k;
      } else break;
    } else break;
  }
  return out;
}

/** First decorator with the given name (case-sensitive). */
export function findDecorator(decorators: readonly Decorator[], ...names: string[]): Decorator | undefined {
  return decorators.find((d) => names.includes(d.name));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Classes and interfaces
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ClassDecl {
  name: string;
  extendsName?: string;
  abstract: boolean;
  decorators: Decorator[];
  /** Offset of the body `{`. */
  bodyOpen: number;
  /** Offset of the body `}`. */
  bodyClose: number;
  /** 0-based line of the class name. */
  line: number;
}

const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g;

export function findClasses(code: Code): ClassDecl[] {
  const m = code.masked;
  const out: ClassDecl[] = [];
  for (const match of m.matchAll(CLASS_RE)) {
    const classKw = match.index;
    const nameStart = classKw + match[0].length - match[1].length;
    let i = classKw + match[0].length;
    i = skipWsFwd(m, i, m.length);
    if (m[i] === '<') {
      const c = code.closing(i);
      if (c > 0) i = c + 1;
    }
    const bodyOpen = m.indexOf('{', i);
    if (bodyOpen < 0) continue;
    const bodyClose = code.closing(bodyOpen);
    if (bodyClose < 0) continue;
    const header = m.slice(classKw, bodyOpen);
    const ext = /\bextends\s+([A-Za-z_$][\w$.]*)/.exec(header);
    const before = m.slice(Math.max(0, classKw - 48), classKw);
    out.push({
      name: match[1],
      extendsName: ext ? lastSegment(ext[1]) : undefined,
      abstract: /\babstract\s+$/.test(before),
      decorators: decoratorsBefore(code, classKw),
      bodyOpen,
      bodyClose,
      line: code.lineAt(nameStart),
    });
  }
  return out;
}

export interface InterfaceDecl {
  name: string;
  bodyOpen: number;
  bodyClose: number;
  line: number;
}

const INTERFACE_RE = /\binterface\s+([A-Za-z_$][\w$]*)|\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(?=\{)/g;

/** `interface Name { … }` and `type Name = { … }` declarations. */
export function findInterfaces(code: Code): InterfaceDecl[] {
  const m = code.masked;
  const out: InterfaceDecl[] = [];
  for (const match of m.matchAll(INTERFACE_RE)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const nameStart = m.indexOf(name, match.index);
    const bodyOpen = m.indexOf('{', match.index + match[0].length - 1);
    if (bodyOpen < 0) continue;
    const bodyClose = code.closing(bodyOpen);
    if (bodyClose < 0) continue;
    out.push({ name, bodyOpen, bodyClose, line: code.lineAt(nameStart) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Members (class properties / interface fields)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MemberDecl {
  name: string;
  decorators: Decorator[];
  /** Only `?` (TS optional). */
  optional: boolean;
  /** Raw type annotation text (`string`, `Generated<number>`, …), `''` when absent. */
  type: string;
  /** Raw initializer text (after `=`), `''` when absent. */
  initializer: string;
  line: number;
}

/** `=` at depth 0 that is a real assignment (not `=>`, `==`, `>=`, …), else -1. */
function assignmentEq(m: string, start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '=') {
      const prev = m[i - 1];
      const next = m[i + 1];
      if (next !== '=' && next !== '>' && !'=!<>+-*/%&|^~'.includes(prev)) return i;
    }
  }
  return -1;
}

/** End of a member declaration starting at `i`: `;` / next `@` / (optionally) a line break / `limit`. */
function statementEnd(m: string, i: number, limit: number, asiNewline: boolean, angle = false): number {
  let depth = 0;
  for (; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (angle && c === '<') depth++;
    else if (angle && c === '>' && m[i - 1] !== '=' && m[i - 1] !== '-') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === ';' || c === ',') return i;
      if (c === '@') return i;
      if (asiNewline && c === '\n') {
        let p = i - 1;
        while (p >= 0 && (m[p] === ' ' || m[p] === '\t' || m[p] === '\r')) p--;
        if ('=<>|&+-*/.,?:([{'.includes(m[p])) continue;
        let q = skipWsFwd(m, i + 1, limit);
        if (m[q] && '|&.?:)]}'.includes(m[q])) continue;
        return i;
      }
    }
  }
  return limit;
}

export interface MemberOptions {
  /** Collect decorators preceding each member (classes), off for interfaces. */
  decorators?: boolean;
  /** Terminate a member at a line break (interfaces / object types without `;`). */
  asiNewline?: boolean;
  /** Track `<…>` as brackets so generic types with commas (`ColumnType<A, B>`) stay intact. */
  angle?: boolean;
}

/** Members declared directly inside the `{…}` body spanning (`open`, `close`). Methods are skipped. */
export function members(code: Code, open: number, close: number, options: MemberOptions = {}): MemberDecl[] {
  const m = code.masked;
  const out: MemberDecl[] = [];
  const limit = close;
  let i = open + 1;
  while (i < limit) {
    i = skipWsFwd(m, i, limit);
    if (i >= limit) break;
    if (m[i] === ';' || m[i] === ',') {
      i++;
      continue;
    }
    const decorators = options.decorators ? consumeDecorators(code, i, limit) : { decorators: [], end: i };
    i = decorators.end;
    i = skipWsFwd(m, i, limit);
    if (i >= limit) break;
    // Skip modifier keywords.
    for (;;) {
      const w = identAt(m, i);
      if (w && MODIFIERS.has(w) && !isCallOrColon(m, i + w.length, limit)) {
        i = skipWsFwd(m, i + w.length, limit);
      } else break;
    }
    if (i >= limit) break;
    if (m[i] === '[') {
      // Index signature or computed key: skip the whole member.
      const c = code.closing(i);
      i = statementEnd(m, c < 0 ? limit : c + 1, limit, !!options.asiNewline, !!options.angle);
      i++;
      continue;
    }
    // Member name (identifier, #private, or quoted key).
    let nameStart = i;
    let name: string;
    if (m[i] === '"' || m[i] === "'" || m[i] === '`') {
      const q = m[i];
      let j = i + 1;
      while (j < limit && code.text[j] !== q) j++;
      name = stringValue(code.text.slice(i, j + 1)) ?? code.text.slice(i + 1, j);
      i = j + 1;
    } else {
      if (m[i] === '#') i++;
      name = identAt(m, i);
      nameStart = i;
      if (!name) {
        i++;
        continue;
      }
      i += name.length;
    }
    let optional = false;
    if (m[i] === '?') {
      optional = true;
      i++;
    } else if (m[i] === '!') {
      i++;
    }
    let p = skipWsFwd(m, i, limit);
    // Method? → skip it.
    if (m[p] === '(' || m[p] === '<') {
      if (m[p] === '<') {
        const c = code.closing(p);
        p = c < 0 ? limit : skipWsFwd(m, c + 1, limit);
      }
      if (m[p] === '(') {
        const c = code.closing(p);
        p = c < 0 ? limit : skipWsFwd(m, c + 1, limit);
      }
      // return type then body / semicolon
      let q = p;
      while (q < limit && m[q] !== '{' && m[q] !== ';' && m[q] !== '}' && m[q] !== '@') q++;
      if (m[q] === '{') {
        const c = code.closing(q);
        i = c < 0 ? limit : c + 1;
      } else i = q;
      continue;
    }
    const end = statementEnd(m, p, limit, !!options.asiNewline, !!options.angle);
    let type = '';
    let initializer = '';
    if (m[p] === ':') {
      const eq = assignmentEq(m, p + 1, end);
      type = code.span(p + 1, eq < 0 ? end : eq).text;
      if (eq >= 0) initializer = code.span(eq + 1, end).text;
    } else if (m[p] === '=') {
      initializer = code.span(p + 1, end).text;
    }
    out.push({ name, decorators: decorators.decorators, optional, type, initializer, line: code.lineAt(nameStart) });
    // When the member ended because the next member's decorator started (`@`), keep the `@` so the
    // next iteration consumes it — code without trailing semicolons (`@Column()\n  name: string`)
    // would otherwise lose that decorator and mis-read the field as a method call.
    i = m[end] === '@' ? end : end + 1;
  }
  return out;
}

/** Consumes a run of `@Decorator(...)` tokens starting at `start`, returning them and the end offset. */
function consumeDecorators(code: Code, start: number, limit: number): { decorators: Decorator[]; end: number } {
  const m = code.masked;
  const decorators: Decorator[] = [];
  let i = skipWsFwd(m, start, limit);
  while (m[i] === '@') {
    const nameStart = i + 1;
    let j = nameStart;
    while (j < limit && (isIdentChar(m[j]) || m[j] === '.')) j++;
    const name = lastSegment(m.slice(nameStart, j));
    let open = -1;
    let k = skipWsFwd(m, j, limit);
    if (m[k] === '(') {
      open = k;
      const c = code.closing(k);
      k = c < 0 ? limit : c + 1;
    }
    decorators.push({ name, open, line: code.lineAt(i) });
    i = skipWsFwd(m, k, limit);
  }
  return { decorators, end: i };
}

function isCallOrColon(m: string, i: number, limit: number): boolean {
  const j = skipWsFwd(m, i, limit);
  return m[j] === ':' || m[j] === '(' || m[j] === '?' || m[j] === '=' || m[j] === ';';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Call chains (`col('x').primaryKey().references(() => y.id, { … })`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Call {
  name: string;
  /** Offset of `(`, or -1 for a bare property access in the chain. */
  open: number;
  /** Offset just after the call (after `)` or after the name). */
  end: number;
  line: number;
}

/** Parses a fluent call chain in `[start, end)`. First element is the head call. */
export function callChain(code: Code, start: number, end: number): Call[] {
  const m = code.masked;
  const out: Call[] = [];
  let i = skipWsFwd(m, start, end);
  const head = identAt(m, i);
  if (!head) return out;
  let p = skipWsFwd(m, i + head.length, end);
  if (m[p] === '<') {
    const c = code.closing(p);
    if (c > 0) p = skipWsFwd(m, c + 1, end);
  }
  if (m[p] !== '(') return out;
  let close = code.closing(p);
  if (close < 0) close = end - 1;
  out.push({ name: head, open: p, end: close + 1, line: code.lineAt(i) });
  i = close + 1;
  for (;;) {
    i = skipWsFwd(m, i, end);
    if (m[i] !== '.') break;
    i = skipWsFwd(m, i + 1, end);
    const name = identAt(m, i);
    if (!name) break;
    let q = skipWsFwd(m, i + name.length, end);
    if (m[q] === '<') {
      const c = code.closing(q);
      if (c > 0) q = skipWsFwd(m, c + 1, end);
    }
    if (m[q] !== '(') {
      out.push({ name, open: -1, end: q, line: code.lineAt(i) });
      i = q;
      continue;
    }
    let c = code.closing(q);
    if (c < 0) c = end - 1;
    out.push({ name, open: q, end: c + 1, line: code.lineAt(i) });
    i = c + 1;
  }
  return out;
}

/**
 * Parses a member-access chain `receiver.a(args).b(args)…` in `[start, end)`: the leading identifier
 * is the receiver (not a call) and every `.method(args)` after it becomes a {@link Call}. Handles the
 * `knex.schema.createTable(...)` and `table.string(...).notNullable()` shapes.
 */
export function propChain(code: Code, start: number, end: number): { receiver: string; calls: Call[] } {
  const m = code.masked;
  let i = skipWsFwd(m, start, end);
  const receiver = identAt(m, i);
  i += receiver.length;
  const calls: Call[] = [];
  for (;;) {
    i = skipWsFwd(m, i, end);
    if (m[i] !== '.') break;
    i = skipWsFwd(m, i + 1, end);
    const name = identAt(m, i);
    if (!name) break;
    let q = skipWsFwd(m, i + name.length, end);
    if (m[q] === '<') {
      const c = code.closing(q);
      if (c > 0) q = skipWsFwd(m, c + 1, end);
    }
    if (m[q] !== '(') {
      calls.push({ name, open: -1, end: q, line: code.lineAt(i) });
      i = q;
      continue;
    }
    let c = code.closing(q);
    if (c < 0) c = end - 1;
    calls.push({ name, open: q, end: c + 1, line: code.lineAt(i) });
    i = c + 1;
  }
  return { receiver, calls };
}

/** `stringValue` of the `idx`-th positional argument of the call opening at `open`. */
export function stringArg(code: Code, open: number, idx = 0): string | undefined {
  if (open < 0) return undefined;
  const sp = code.args(open).positional[idx];
  return sp ? stringValue(sp.text) : undefined;
}

export interface TsType {
  type: string;
  isArray: boolean;
}

/** Normalises a TS type annotation into a column type: drops `| null`/`| undefined`, detects arrays. */
export function normalizeTsType(raw: string): TsType {
  let t = (raw ?? '').trim();
  if (!t) return { type: '', isArray: false };
  t = t.replace(/\|\s*(?:null|undefined)\b/g, '').replace(/\b(?:null|undefined)\s*\|/g, '').trim();
  let isArray = false;
  const arr = /^Array<(.+)>$/.exec(t);
  if (arr) {
    isArray = true;
    t = arr[1].trim();
  } else if (/\[\]$/.test(t)) {
    isArray = true;
    t = t.replace(/\[\]$/, '').trim();
  }
  if (/[<>{}|&]/.test(t)) return { type: '', isArray };
  return { type: t, isArray };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Top-level `const` / `export const` assignments
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ConstDecl {
  name: string;
  /** Offset just after the `=`. */
  valueStart: number;
  line: number;
}

const CONST_RE = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;

/** `export const name = …` declarations (any nesting level). */
export function findConsts(code: Code): ConstDecl[] {
  const m = code.masked;
  const out: ConstDecl[] = [];
  for (const match of m.matchAll(CONST_RE)) {
    const nameStart = m.indexOf(match[1], match.index);
    out.push({ name: match[1], valueStart: match.index + match[0].length, line: code.lineAt(nameStart) });
  }
  return out;
}

/** Leading doc-comment text of the line at `offset`, cleaned, or undefined. */
export function docComment(code: Code, offset: number): string | undefined {
  const parts = code.leadingComments(offset);
  if (!parts.length) return undefined;
  const text = parts.map((p) => cleanComment(p)).join('\n').trim();
  return text || undefined;
}
