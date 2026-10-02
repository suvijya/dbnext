/**
 * Shared helpers for the JavaScript / TypeScript model parsers (Sequelize and Mongoose).
 * Prisma has its own module.
 *
 * The main piece is a small structural scanner for decorator-based classes
 * (sequelize-typescript, @nestjs/mongoose, Typegoose): it finds classes, their class-level
 * decorators (`@Table`, `@Schema`), and their members with the decorators and TS type attached.
 *
 * Pure, synchronous, no Node APIs – runs in the browser build too.
 */

import type { Args, Code, Span } from '../../core/text';

/** JS / TS extensions all three JS-model parsers claim. */
export const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

const MODIFIERS = new Set([
  'export',
  'default',
  'public',
  'private',
  'protected',
  'readonly',
  'declare',
  'static',
  'abstract',
  'override',
  'async',
  'accessor',
]);

const WS = /\s/;

export interface Decorator {
  /** Last segment, e.g. `Column` for `@orm.Column`. */
  name: string;
  /** Full dotted name as written. */
  full: string;
  /** Offset of `@`. */
  start: number;
  /** Offset just past the decorator (after `)` or the name). */
  end: number;
  /** Offset of `(` or -1 when the decorator has no arguments. */
  open: number;
  /** Offset of the matching `)` or -1. */
  close: number;
}

export interface Member {
  kind: 'prop' | 'method';
  name: string;
  /** TS type annotation text (stripped), `''` when absent. */
  type: string;
  /** Declared with a trailing `?`. */
  optional: boolean;
  decorators: Decorator[];
  /** Offset of the first modifier / name token. */
  start: number;
  line: number;
  /** Method body `{` / `}` offsets, when present. */
  bodyOpen?: number;
  bodyClose?: number;
}

export interface ClassDef {
  name: string;
  extendsName?: string;
  decorators: Decorator[];
  members: Member[];
  bodyOpen: number;
  bodyClose: number;
  /** Offset of the `class` keyword. */
  keyword: number;
  line: number;
}

interface DecoratorIndex {
  byEnd: Map<number, Decorator>;
  byStart: Map<number, Decorator>;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && WS.test(ch);
}

/** All `@Decorator` / `@ns.Decorator(...)` occurrences, indexed by start and (exclusive) end offset. */
function indexDecorators(code: Code): DecoratorIndex {
  const m = code.masked;
  const byEnd = new Map<number, Decorator>();
  const byStart = new Map<number, Decorator>();
  const re = /@([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const start = mt.index;
    const full = mt[1].replace(/\s+/g, '');
    let j = start + mt[0].length;
    while (j < m.length && (m[j] === ' ' || m[j] === '\t')) j++;
    let open = -1;
    let close = -1;
    let end = start + mt[0].length;
    if (m[j] === '(') {
      open = j;
      close = code.closing(j);
      end = close < 0 ? m.length : close + 1;
    }
    const d: Decorator = { name: full.split('.').pop() ?? full, full, start, end, open, close };
    byEnd.set(end, d);
    byStart.set(start, d);
  }
  return { byEnd, byStart };
}

/** Decorators that directly precede `start` (only whitespace in between), in source order. */
function precedingDecorators(code: Code, byEnd: Map<number, Decorator>, start: number): Decorator[] {
  const m = code.masked;
  const out: Decorator[] = [];
  let pos = start;
  for (;;) {
    let p = pos - 1;
    while (p >= 0 && isSpace(m[p])) p--;
    const d = byEnd.get(p + 1);
    if (!d) break;
    out.unshift(d);
    pos = d.start;
  }
  return out;
}

/** Finds every `class` declaration with its members and decorators. */
export function findClasses(code: Code): ClassDef[] {
  const m = code.masked;
  const index = indexDecorators(code);
  const out: ClassDef[] = [];
  const re = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const keyword = mt.index;
    const name = mt[1];
    let p = keyword + mt[0].length;
    // skip generics `<...>`
    while (p < m.length && (m[p] === ' ' || m[p] === '\t')) p++;
    if (m[p] === '<') {
      const c = code.closing(p);
      p = c < 0 ? m.length : c + 1;
    }
    // extends clause
    let extendsName: string | undefined;
    const em = /^\s*extends\s+([A-Za-z_$][\w$.]*)/.exec(code.stripped.slice(p, Math.min(p + 400, m.length)));
    if (em) extendsName = em[1].split('.').pop();
    // locate the class body `{`, stepping over generic argument lists that may contain braces
    let b = p;
    while (b < m.length) {
      const ch = m[b];
      if (ch === '<') {
        const c = code.closing(b);
        b = c < 0 ? m.length : c + 1;
        continue;
      }
      if (ch === '{') break;
      b++;
    }
    if (b >= m.length) continue;
    const bodyClose = code.closing(b);
    const close = bodyClose < 0 ? m.length : bodyClose;
    out.push({
      name,
      extendsName,
      decorators: precedingDecorators(code, index.byEnd, leadingModifierStart(code, keyword)),
      members: scanMembers(code, b + 1, close, index),
      bodyOpen: b,
      bodyClose: close,
      keyword,
      line: code.lineAt(keyword),
    });
    re.lastIndex = b + 1;
  }
  return out;
}

/** Offset where the `export` / `abstract` / … modifier run before `class` begins. */
function leadingModifierStart(code: Code, keyword: number): number {
  const s = code.stripped;
  let hs = keyword;
  for (;;) {
    let p = hs - 1;
    while (p >= 0 && isSpace(s[p])) p--;
    const wm = /([A-Za-z_$][\w$]*)$/.exec(s.slice(0, p + 1));
    if (!wm || !MODIFIERS.has(wm[1])) break;
    hs = p + 1 - wm[1].length;
  }
  return hs;
}

const ID_AT = /^[#A-Za-z_$][\w$]*/;

function scanMembers(code: Code, start: number, end: number, index: DecoratorIndex): Member[] {
  const m = code.masked;
  const s = code.stripped;
  const members: Member[] = [];
  let i = start;
  let memberStart = -1;
  while (i < end) {
    const c = m[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '@') {
      const d = index.byStart.get(i);
      i = d ? d.end : i + 1;
      continue;
    }
    if (c === ';' || c === ',') {
      memberStart = -1;
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const cl = code.closing(i);
      i = cl < 0 ? end : cl + 1;
      memberStart = -1;
      continue;
    }
    const idm = ID_AT.exec(s.slice(i, i + 128));
    if (!idm) {
      i++;
      continue;
    }
    const word = idm[0];
    if (memberStart < 0) memberStart = i;
    const afterWord = i + word.length;
    if (MODIFIERS.has(word) || word === 'get' || word === 'set') {
      i = afterWord;
      continue;
    }
    let k = afterWord;
    while (k < end && isSpace(m[k])) k++;
    const optional = m[k] === '?';

    if (m[k] === '(') {
      // method
      const paramsClose = code.closing(k);
      let a = paramsClose < 0 ? end : paramsClose + 1;
      while (a < end && isSpace(m[a])) a++;
      let bodyOpen: number | undefined;
      let bodyClose: number | undefined;
      if (m[a] === ':') {
        let j = a + 1;
        while (j < end && m[j] !== '{' && m[j] !== ';' && m[j] !== '}') j++;
        if (m[j] === '{') {
          bodyOpen = j;
          bodyClose = code.closing(j);
        }
        a = j;
      } else if (m[a] === '{') {
        bodyOpen = a;
        bodyClose = code.closing(a);
      }
      members.push({
        kind: 'method',
        name: word,
        type: '',
        optional: false,
        decorators: precedingDecorators(code, index.byEnd, memberStart),
        start: memberStart,
        line: code.lineAt(memberStart),
        bodyOpen,
        bodyClose: bodyClose !== undefined && bodyClose < 0 ? undefined : bodyClose,
      });
      i = bodyClose !== undefined && bodyClose >= 0 ? bodyClose + 1 : Math.max(a + 1, i + 1);
      memberStart = -1;
      continue;
    }

    // property declaration – read until `;` / newline at depth 0, skipping bracketed initializers
    let j = optional ? k + 1 : k;
    let colon = -1;
    let eq = -1;
    while (j < end) {
      const cj = m[j];
      if (cj === '(' || cj === '[' || cj === '{') {
        const cl = code.closing(j);
        j = cl < 0 ? end : cl + 1;
        continue;
      }
      if (cj === ')' || cj === ']' || cj === '}') break;
      if (cj === ';' || cj === '\n') break;
      if (cj === ':' && colon < 0 && eq < 0) colon = j;
      else if (cj === '=' && eq < 0 && m[j + 1] !== '=' && m[j + 1] !== '>' && m[j - 1] !== '=' && m[j - 1] !== '!' && m[j - 1] !== '<' && m[j - 1] !== '>') {
        eq = j;
      }
      j++;
    }
    const stmtEnd = j;
    let type = '';
    if (colon >= 0) type = s.slice(colon + 1, eq >= 0 ? eq : stmtEnd).trim();
    members.push({
      kind: 'prop',
      name: word,
      type,
      optional,
      decorators: precedingDecorators(code, index.byEnd, memberStart),
      start: memberStart,
      line: code.lineAt(memberStart),
    });
    i = m[stmtEnd] === ';' ? stmtEnd + 1 : stmtEnd;
    memberStart = -1;
  }
  return members;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Value helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Parsed arguments of a decorator (`undefined` when it has no `(...)`). */
export function decoratorArgs(code: Code, d: Decorator): Args | undefined {
  return d.open >= 0 ? code.args(d.open) : undefined;
}

/** First positional argument span of a decorator / call opening at `(`, when present. */
export function firstArg(args: Args | undefined): Span | undefined {
  return args?.positional[0];
}

/** Last identifier of a (possibly dotted / generic / quoted) expression: `models.Post` → `Post`. */
export function lastSegment(expr: string): string {
  const cleaned = expr.trim().replace(/^["'`]|["'`]$/g, '').replace(/<[^>]*>/g, '').replace(/\(\s*\)$/, '');
  const parts = cleaned.split(/[.\\/]/).filter(Boolean);
  return (parts.length ? parts[parts.length - 1] : cleaned).trim();
}

/**
 * Model name referenced by a Sequelize / Mongoose target expression:
 * `() => Team` → `Team`, `models.Post` → `Post`, `'User'` → `User`, `Tag` → `Tag`.
 */
export function refModel(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const t = expr.trim();
  const arrow = /=>\s*([A-Za-z_$][\w$.]*)/.exec(t);
  if (arrow) return lastSegment(arrow[1]);
  const name = lastSegment(t);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/**
 * Lightly normalises a Sequelize type expression: `DataTypes.STRING(255)` → `STRING(255)`,
 * `Sequelize.INTEGER` → `INTEGER`, `DataType.ENUM('a','b')` → `ENUM('a','b')`.
 */
export function sequelizeType(expr: string | undefined): string {
  if (!expr) return '';
  let t = expr.trim();
  t = t.replace(/^(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:DataTypes|DataType|Sequelize)\s*\.\s*/, '');
  // leftover like `Sequelize.DataTypes.STRING`
  t = t.replace(/^[A-Za-z_$][\w$]*\s*\.\s*/, (seg) => (/^(DataTypes|DataType|Sequelize)\b/.test(seg.trim()) ? '' : seg));
  return t.trim();
}
