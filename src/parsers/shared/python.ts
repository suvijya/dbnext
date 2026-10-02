/**
 * Shared helpers for the Python ORM parsers (Django, SQLAlchemy, SQLModel, Peewee, Tortoise).
 *
 * All five parsers run on the same `.py` files, so the heavy lifting – lexing once, finding class
 * declarations, walking class members, reading call arguments – lives here. Everything is pure and
 * synchronous and works on a {@link Code} lexed as `'python'`.
 */

import type { Args, Block, Code } from '../../core/text';
import { boolValue, splitQualified, stringValue } from '../../core/text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Classes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PyClass {
  name: string;
  /** Positional base-class expressions, trimmed (`models.Model`, `Base`, `SQLModel`). */
  bases: string[];
  /** Last dotted segment of each base (`models.Model` → `Model`). */
  baseNames: string[];
  /** Class keyword arguments, e.g. `table=True` → `table` → `True`. */
  kw: Map<string, string>;
  /** Offset of the `class` keyword. */
  classKw: number;
  /** 0-based line of the `class` keyword. */
  line: number;
  /** 0-based line of the header's closing colon. */
  headerEndLine: number;
  /** Indentation width of the class header. */
  indent: number;
  body: Block;
}

const CLASS_RE = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)/gm;

/** All class declarations in the file (including nested ones), in source order. */
export function findClasses(code: Code): PyClass[] {
  const m = code.masked;
  const out: PyClass[] = [];
  for (const mt of m.matchAll(CLASS_RE)) {
    const classKw = mt.index + mt[1].length;
    const name = mt[2];
    const line = code.lineAt(classKw);
    let j = classKw + mt[0].length - mt[1].length; // just after the class name
    while (j < m.length && (m[j] === ' ' || m[j] === '\t')) j++;
    // PEP 695 generics: `class Foo[T](Base):`
    if (m[j] === '[') {
      const c = code.closing(j);
      j = c < 0 ? j + 1 : c + 1;
      while (j < m.length && (m[j] === ' ' || m[j] === '\t')) j++;
    }
    let bases: string[] = [];
    let baseNames: string[] = [];
    const kw = new Map<string, string>();
    let afterParen = j;
    if (m[j] === '(') {
      const a = code.args(j);
      bases = a.positional.map((s) => s.text);
      baseNames = bases.map(tail);
      for (const [k, span] of a.named) kw.set(k, span.text);
      afterParen = a.end;
    }
    let p = afterParen;
    while (p < m.length && m[p] !== ':' && m[p] !== '\n') p++;
    const colon = p < m.length && m[p] === ':' ? p : afterParen;
    const headerEndLine = code.lineAt(colon);
    const body = code.indentedBlock(line, headerEndLine);
    out.push({ name, bases, baseNames, kw, classKw, line, headerEndLine, indent: code.indentOf(line), body });
  }
  return out;
}

/** Nested class `name` directly inside `cls` (e.g. a Django `class Meta:`). */
export function nestedClass(code: Code, all: readonly PyClass[], cls: PyClass, name: string): PyClass | undefined {
  const memberIndent = firstMemberIndent(code, cls);
  return all.find(
    (c) => c !== cls && c.name === name && c.classKw > cls.body.start && c.classKw < cls.body.end && c.indent === memberIndent,
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Members (field assignments, annotations)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PyMember {
  /** Field / attribute name (`''` for decorators). */
  name: string;
  line: number;
  start: number;
  end: number;
  isClass: boolean;
  isDef: boolean;
  isDecorator: boolean;
  /** Type annotation text (`int`, `Mapped[int]`, `Team | None`), when present. */
  annotation?: string;
  /** Right-hand side text, when present. */
  valueText?: string;
  /** Offset of the first character of the right-hand side, when present. */
  valueStart?: number;
  /** Dotted call name of the RHS, e.g. `models.CharField`. */
  callName?: string;
  /** Last segment of {@link callName}. */
  callBase?: string;
  /** Offset of the call's opening `(`. */
  callOpen?: number;
}

/** Direct members of a class body (not nested class / method bodies). */
export function classMembers(code: Code, cls: PyClass): PyMember[] {
  const out: PyMember[] = [];
  const block = cls.body;
  let first = block.startLine;
  while (first <= block.endLine && isBlankLine(code, first)) first++;
  if (first > block.endLine) return out;
  const memberIndent = code.indentOf(first);
  let line = first;
  while (line <= block.endLine) {
    if (isBlankLine(code, line) || code.indentOf(line) !== memberIndent) {
      line++;
      continue;
    }
    const s = code.lineStart(line);
    const e = code.statementEnd(s);
    const mem = parseMember(code, s, e);
    if (mem) out.push(mem);
    line = Math.max(code.lineAt(e) + 1, line + 1);
  }
  return out;
}

function firstMemberIndent(code: Code, cls: PyClass): number {
  let first = cls.body.startLine;
  while (first <= cls.body.endLine && isBlankLine(code, first)) first++;
  return first <= cls.body.endLine ? code.indentOf(first) : cls.indent + 4;
}

function isBlankLine(code: Code, line: number): boolean {
  return code.line(line).trim() === '';
}

function parseMember(code: Code, start: number, end: number): PyMember | undefined {
  const m = code.masked;
  let i = start;
  while (i < end && (m[i] === ' ' || m[i] === '\t')) i++;
  const line = code.lineAt(start);
  if (m[i] === '@') return { name: '', line, start, end, isClass: false, isDef: false, isDecorator: true };
  const idm = /^(?:async\s+)?[A-Za-z_]\w*/.exec(m.slice(i, end));
  if (!idm) return undefined;
  const first = idm[0].replace(/^async\s+/, '');
  if (first === 'class') {
    const nm = /^class\s+([A-Za-z_]\w*)/.exec(m.slice(i, end));
    return { name: nm?.[1] ?? '', line, start, end, isClass: true, isDef: false, isDecorator: false };
  }
  if (first === 'def') {
    const nm = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(m.slice(i, end));
    return { name: nm?.[1] ?? '', line, start, end, isClass: false, isDef: true, isDecorator: false };
  }
  if (/^(if|elif|else|for|while|with|try|except|finally|return|pass|raise|import|from|global|nonlocal|assert|del|yield)$/.test(first)) {
    return undefined;
  }
  const name = first;
  const afterName = i + idm[0].length;
  let depth = 0;
  let annColon = -1;
  let eq = -1;
  for (let j = afterName; j < end; j++) {
    const c = m[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if (c === ':' && m[j + 1] !== '=' && annColon < 0 && eq < 0) annColon = j;
      else if (c === '=' && m[j - 1] !== '=' && m[j - 1] !== '!' && m[j - 1] !== '<' && m[j - 1] !== '>' && m[j - 1] !== ':' && m[j + 1] !== '=') {
        eq = j;
        break;
      }
    }
  }
  const mem: PyMember = { name, line, start, end, isClass: false, isDef: false, isDecorator: false };
  if (annColon >= 0) mem.annotation = code.span(annColon + 1, eq >= 0 ? eq : end).text;
  if (eq >= 0) {
    const valueStart = eq + 1;
    mem.valueStart = valueStart;
    mem.valueText = code.span(valueStart, end).text;
    const cm = /^\s*([A-Za-z_][\w.]*)\s*\(/.exec(code.slice(valueStart, end));
    if (cm) {
      mem.callName = cm[1];
      mem.callBase = tail(cm[1]);
      mem.callOpen = valueStart + cm[0].length - 1;
    }
  }
  return mem;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Docstrings & comments
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The class docstring (first string statement in the body), trimmed. */
export function docstring(code: Code, cls: PyClass): string | undefined {
  const block = cls.body;
  let first = block.startLine;
  while (first <= block.endLine && isBlankLine(code, first)) first++;
  if (first > block.endLine) return undefined;
  const s = code.lineStart(first);
  const e = code.statementEnd(s);
  const text = code.slice(s, e).trim();
  const v = stringValue(text);
  return v !== undefined ? v.trim() || undefined : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Argument helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function namedString(args: Args, key: string): string | undefined {
  const sp = args.named.get(key);
  return sp ? stringValue(sp.text) : undefined;
}

export function namedBool(args: Args, key: string): boolean | undefined {
  const sp = args.named.get(key);
  return sp ? boolValue(sp.text) : undefined;
}

export function namedText(args: Args, key: string): string | undefined {
  return args.named.get(key)?.text;
}

export function positionalText(args: Args, index: number): string | undefined {
  return args.positional[index]?.text;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Misc string helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Last dotted segment of an expression, dropping generics: `models.Model` → `Model`, `List[X]` → `List`. */
export function tail(expr: string): string {
  let t = expr.trim().replace(/^["'`]|["'`]$/g, '');
  const br = t.indexOf('[');
  if (br >= 0) t = t.slice(0, br);
  const parts = t.split('.').filter(Boolean);
  return (parts.length ? parts[parts.length - 1] : t).trim();
}

/** Type name without its module qualifier, keeping call arguments: `sa.String(50)` → `String(50)`. */
export function typeName(expr: string | undefined): string {
  if (!expr) return '';
  const t = expr.trim();
  const paren = t.indexOf('(');
  const head = (paren < 0 ? t : t.slice(0, paren)).trim();
  const rest = paren < 0 ? '' : t.slice(paren);
  const seg = head.split('.').filter(Boolean).pop() ?? head;
  return (seg + rest).trim();
}

/** Splits a type expression on top-level `|` (PEP 604 unions). */
function splitUnion(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let seg = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    if (c === '|' && depth === 0) {
      out.push(seg);
      seg = '';
    } else seg += c;
  }
  out.push(seg);
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * Unwraps `Mapped[…]`, `Optional[…]` and `X | None` type annotations.
 * Returns the inner type text and whether the annotation was optional / nullable.
 */
export function unwrapOptional(annotation: string | undefined): { type: string; optional: boolean } {
  let s = (annotation ?? '').trim();
  let optional = false;
  const mapped = /^(?:[\w.]*\.)?Mapped\s*\[(.*)\]$/s.exec(s);
  if (mapped) s = mapped[1].trim();
  const opt = /^(?:[\w.]*\.)?Optional\s*\[(.*)\]$/s.exec(s);
  if (opt) {
    s = opt[1].trim();
    optional = true;
  }
  const parts = splitUnion(s);
  if (parts.length > 1) {
    const rest = parts.filter((p) => p !== 'None' && p !== 'type(None)');
    if (rest.length < parts.length) optional = true;
    s = rest.length === 1 ? rest[0] : rest.join(' | ');
  }
  // Strip surrounding quotes from forward references ("User").
  s = s.replace(/^["']|["']$/g, '').trim();
  return { type: s, optional };
}

/**
 * Collection / typing wrappers that are never the related model inside a relationship annotation.
 * Covers SQLAlchemy's `Mapped`, `WriteOnlyMapped`, `DynamicMapped` and the usual typing containers.
 */
const RELATION_WRAPPERS = new Set([
  'Mapped',
  'WriteOnlyMapped',
  'DynamicMapped',
  'Optional',
  'Union',
  'None',
  'list',
  'List',
  'set',
  'Set',
  'frozenset',
  'tuple',
  'Tuple',
  'Sequence',
  'Collection',
  'Iterable',
  'MutableList',
  'dict',
  'Dict',
]);

/**
 * Innermost related-model name of a relationship type annotation, skipping container / typing
 * wrappers: `Mapped[list["User"]]` → `User`, `so.WriteOnlyMapped['User']` → `User`, `Optional[Team]` → `Team`.
 */
export function annotationModel(annotation: string | undefined): string | undefined {
  if (!annotation) return undefined;
  const names = annotation.match(/[A-Za-z_]\w*/g) ?? [];
  for (let i = names.length - 1; i >= 0; i--) {
    if (!RELATION_WRAPPERS.has(names[i])) return names[i];
  }
  return undefined;
}

/** Splits a `"table.column"` / `"schema.table.column"` foreign-key target. */
export function splitFkTarget(target: string): { schema?: string; table: string; column?: string } {
  const parts = splitQualified(target);
  if (parts.length >= 3) return { schema: parts[0], table: parts[parts.length - 2], column: parts[parts.length - 1] };
  if (parts.length === 2) return { table: parts[0], column: parts[1] };
  return { table: parts[0] ?? target };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Structural scanning
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CallSite {
  /** Full dotted name of the call (`sa.Column`, `models.Index`). */
  name: string;
  /** Last dotted segment (`Column`, `Index`). */
  base: string;
  /** Offset of the opening `(`. */
  open: number;
}

const CALL_RE = /([A-Za-z_][\w.]*)\s*\(/g;

/** Finds every call `name(` whose last segment is in `bases` within `[start, end)`, outside strings. */
export function findCalls(code: Code, start: number, end: number, bases: readonly string[]): CallSite[] {
  const m = code.masked;
  const want = new Set(bases);
  const out: CallSite[] = [];
  CALL_RE.lastIndex = start;
  let mt: RegExpExecArray | null;
  while ((mt = CALL_RE.exec(m)) && mt.index < end) {
    const open = mt.index + mt[0].length - 1;
    const base = tail(mt[1]);
    if (want.has(base)) out.push({ name: mt[1], base, open });
  }
  CALL_RE.lastIndex = 0;
  return out;
}

/** Offset of the first `(`, `[` or `{` at/after `from`, within the line-ish range `[from, end)`. */
export function bracketAt(code: Code, from: number, end: number): number {
  const m = code.masked;
  for (let i = from; i < end; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') return i;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return -1;
  }
  return -1;
}

/** Offset of the first `(` within `[from, end)` (the opening paren of a `Name(...)` call), or -1. */
export function firstParen(code: Code, from: number, end: number): number {
  const i = code.masked.indexOf('(', from);
  return i >= 0 && i < end ? i : -1;
}

/** Quoted string literals that appear in `text`, in order (handy for `fields=['a', 'b']`). */
export function quotedList(text: string): string[] {
  const out: string[] = [];
  for (const mt of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) out.push(mt[1] ?? mt[2] ?? '');
  return out.filter((s) => s !== '');
}

