/**
 * Shared helpers for the Go and Rust ORM parsers (GORM, Ent, Bun — `go`; SeaORM — `rust`).
 *
 * Go models are plain structs with back-tick field tags (`gorm:"…"`, `bun:"…"`), so these helpers
 * find struct declarations, split their fields (name + type + tag) and parse the tags. Rust SeaORM
 * entities are `#[derive(…)]`-annotated `struct` / `enum` declarations, so there are helpers to read
 * the derive list, the `#[sea_orm(…)]` attribute and the struct fields / enum variants.
 *
 * Pure, synchronous TypeScript — no Node APIs (also runs in the web extension build).
 */

import type { Code } from '../../core/text';

const isWs = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Go: struct declarations and fields
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface GoStruct {
  name: string;
  exported: boolean;
  /** Offset of the opening `{`. */
  open: number;
  /** Offset of the matching `}` (text length when unbalanced). */
  close: number;
  /** 0-based line of the `type` keyword. */
  line: number;
}

const STRUCT_RE = /\btype\s+(\w+)\s+struct\s*\{/g;

/** All named `type X struct { … }` declarations (anonymous nested structs are ignored). */
export function goStructs(code: Code): GoStruct[] {
  const out: GoStruct[] = [];
  const m = code.masked;
  for (const match of m.matchAll(STRUCT_RE)) {
    const open = match.index + match[0].length - 1;
    const close = code.closing(open);
    out.push({
      name: match[1],
      exported: /^[A-Z]/.test(match[1]),
      open,
      close: close < 0 ? code.text.length : close,
      line: code.lineAt(match.index),
    });
  }
  return out;
}

export interface GoField {
  /** Field names (several for `A, B int`); empty for embedded fields. */
  names: string[];
  embedded: boolean;
  /** Base type with `*` and `[]` stripped (`CreditCard`, `time.Time`, `string`). */
  type: string;
  pointer: boolean;
  /** Slice type (`[]T`). */
  isArray: boolean;
  /** Raw tag text between the back-ticks (`gorm:"…" json:"…"`), `''` when absent. */
  tag: string;
  /** 0-based line of the field. */
  line: number;
}

export interface GoType {
  pointer: boolean;
  isArray: boolean;
  base: string;
}

/** Splits a Go type into pointer / slice flags and the base name: `[]*time.Time` → `time.Time`. */
export function parseGoType(raw: string): GoType {
  let s = raw.trim();
  let pointer = false;
  let isArray = false;
  for (;;) {
    if (s.startsWith('*')) {
      pointer = true;
      s = s.slice(1).trimStart();
    } else if (s.startsWith('[]')) {
      isArray = true;
      s = s.slice(2).trimStart();
    } else break;
  }
  return { pointer, isArray, base: s };
}

const FIELD_RE = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+([\s\S]+)$/;

/** Parses the fields of the struct whose `{` is at `open` (one field per line, `;` also separates). */
export function goStructFields(code: Code, open: number): GoField[] {
  const out: GoField[] = [];
  const close = code.closing(open);
  const end = close < 0 ? code.text.length : close;
  const masked = code.masked;
  let pos = open + 1;
  while (pos < end) {
    let nl = masked.indexOf('\n', pos);
    if (nl < 0 || nl > end) nl = end;
    for (const seg of splitMasked(masked, pos, nl, ';')) parseGoField(code, seg[0], seg[1], out);
    pos = nl + 1;
  }
  return out;
}

/** `[start,end)` spans separated by `sep` at bracket depth 0 (string contents are already masked). */
function splitMasked(masked: string, start: number, end: number, sep: string): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let seg = start;
  for (let i = start; i < end; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === sep) {
      out.push([seg, i]);
      seg = i + 1;
    }
  }
  out.push([seg, end]);
  return out;
}

function parseGoField(code: Code, start: number, end: number, out: GoField[]): void {
  const masked = code.masked;
  const stripped = code.stripped;
  let s = start;
  let e = end;
  while (s < e && isWs(masked[s])) s++;
  while (e > s && isWs(masked[e - 1])) e--;
  if (s >= e) return;

  let tag = '';
  let declEnd = e;
  const bt = masked.indexOf('`', s);
  if (bt >= 0 && bt < e) {
    declEnd = bt;
    let close = masked.indexOf('`', bt + 1);
    if (close < 0 || close > e) close = e - 1;
    tag = stripped.slice(bt + 1, close);
  }
  const decl = stripped.slice(s, declEnd).trim();
  if (!decl) return;
  const line = code.lineAt(s);

  const m = FIELD_RE.exec(decl);
  if (m) {
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    const t = parseGoType(m[2]);
    out.push({ names, embedded: false, type: t.base, pointer: t.pointer, isArray: t.isArray, tag, line });
  } else {
    const t = parseGoType(decl);
    out.push({ names: [], embedded: true, type: t.base, pointer: t.pointer, isArray: t.isArray, tag, line });
  }
}

export const GO_BUILTIN_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'uintptr', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128',
]);

/** A field type that maps to a single scalar column (builtin, qualified value type, map, `[]byte`). */
export function isGoScalarType(t: GoType): boolean {
  if (t.base.startsWith('map[')) return true;
  if (t.base.includes('.')) return true; // time.Time, sql.NullString, uuid.UUID, datatypes.JSON…
  return GO_BUILTIN_TYPES.has(t.base);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Go: struct tags
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TAG_RE = /(\w+):"((?:[^"\\]|\\.)*)"/g;

/** `gorm:"primaryKey" json:"id"` → Map { gorm → "primaryKey", json → "id" }. */
export function parseStructTag(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(TAG_RE)) out.set(m[1], m[2]);
  return out;
}

/** Splits a string on `sep` honouring `\`-escapes (used for GORM's `;`-separated settings). */
export function splitEscaped(value: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      cur += value[++i];
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Go: methods (`func (recv) Name(…) … { … }`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface GoMethod {
  /** Receiver type without pointer: `User`. */
  recv: string;
  name: string;
  /** Offset of the body `{`. */
  open: number;
  /** Offset of the body `}`. */
  close: number;
  line: number;
}

const METHOD_RE = /\bfunc\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)\s*(\w+)\s*\(/g;

/** Methods with a receiver, with their body range resolved. */
export function goMethods(code: Code): GoMethod[] {
  const out: GoMethod[] = [];
  const m = code.masked;
  for (const match of m.matchAll(METHOD_RE)) {
    const paramsOpen = match.index + match[0].length - 1;
    const paramsClose = code.closing(paramsOpen);
    if (paramsClose < 0) continue;
    let bodyOpen = paramsClose + 1;
    while (bodyOpen < m.length && m[bodyOpen] !== '{' && m[bodyOpen] !== '\n') bodyOpen++;
    if (m[bodyOpen] !== '{') continue;
    const bodyClose = code.closing(bodyOpen);
    out.push({ recv: match[1], name: match[2], open: bodyOpen, close: bodyClose < 0 ? m.length : bodyClose, line: code.lineAt(match.index) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rust: derive-annotated struct / enum declarations
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RustAttr {
  start: number;
  end: number;
  text: string;
}

function rustAttrs(code: Code): RustAttr[] {
  const out: RustAttr[] = [];
  const m = code.masked;
  for (let i = 0; i < m.length - 1; i++) {
    if (m[i] === '#' && (m[i + 1] === '[' || (m[i + 1] === '!' && m[i + 2] === '['))) {
      const bracket = m[i + 1] === '[' ? i + 1 : i + 2;
      const close = code.closing(bracket);
      if (close < 0) continue;
      out.push({ start: i, end: close + 1, text: code.stripped.slice(i, close + 1) });
      i = close;
    }
  }
  return out;
}

export interface RustItem {
  kind: 'struct' | 'enum';
  name: string;
  /** Derive macro names: `['DeriveEntityModel', 'Clone', 'Debug']`. */
  derives: string[];
  /** Raw inner text of the item's `#[sea_orm(…)]` attribute, or `''`. */
  seaOrm: string;
  /** Offset of the body `{`, or -1 for unit / tuple declarations. */
  open: number;
  /** Offset of the body `}`. */
  close: number;
  line: number;
}

const RUST_DECL_RE = /\b(struct|enum)\s+(\w+)/g;
const DERIVE_RE = /#!?\[\s*derive\s*\(([\s\S]*?)\)\s*\]/;
const SEAORM_ATTR_RE = /#!?\[\s*sea_orm\s*\(([\s\S]*)\)\s*\]/;

/** `#[derive(…)]`-annotated structs and enums with their derive list and `#[sea_orm(…)]` attribute. */
export function rustItems(code: Code): RustItem[] {
  const attrs = rustAttrs(code);
  const m = code.masked;
  const out: RustItem[] = [];
  for (const match of m.matchAll(RUST_DECL_RE)) {
    const declStart = match.index;
    // Gather the run of attributes immediately above the declaration.
    const preceding: RustAttr[] = [];
    let boundary = declStart;
    for (let a = attrs.length - 1; a >= 0; a--) {
      const at = attrs[a];
      if (at.end > boundary) continue;
      // Only whitespace and visibility modifiers (`pub`, `pub(crate)`) may sit between the
      // attributes and the `struct` / `enum` keyword.
      const gap = code.stripped.slice(at.end, boundary).replace(/\bpub\s*(?:\([^)]*\))?/g, '').trim();
      if (gap !== '') break;
      preceding.unshift(at);
      boundary = at.start;
    }
    const attrText = preceding.map((a) => a.text).join('\n');
    const dm = DERIVE_RE.exec(attrText);
    if (!dm) continue;
    const derives = dm[1].split(',').map((s) => s.trim().split(/\s*::\s*/).pop() ?? '').filter(Boolean);
    const sm = SEAORM_ATTR_RE.exec(attrText);
    // Resolve the body range.
    let p = declStart + match[0].length;
    while (p < m.length && m[p] !== '{' && m[p] !== ';' && m[p] !== '(') p++;
    const open = m[p] === '{' ? p : -1;
    const close = open >= 0 ? code.closing(open) : -1;
    out.push({
      kind: match[1] as 'struct' | 'enum',
      name: match[2],
      derives,
      seaOrm: sm ? sm[1] : '',
      open,
      close: close < 0 ? m.length : close,
      line: code.lineAt(declStart),
    });
  }
  return out;
}

/** Splits on `sep` at bracket depth 0, ignoring `(` `[` `{` `<` pairs and double-quoted strings. */
export function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === '(' || c === '[' || c === '{' || c === '<') {
      depth++;
      cur += c;
    } else if (c === ')' || c === ']' || c === '}' || c === '>') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export interface RustArgs {
  /** `key = value` entries with the value trimmed. */
  named: Map<string, string>;
  /** Bare flags (`nullable`, `unique`, `primary_key`, `indexed`). */
  flags: Set<string>;
}

/** Parses an attribute's inner text: `rs_type = "String", nullable, unique` → named + flags. */
export function parseRustArgs(inner: string): RustArgs {
  const named = new Map<string, string>();
  const flags = new Set<string>();
  for (const part of splitTopLevel(inner, ',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = splitEqOutsideStr(p);
    if (eq) named.set(eq[0].trim(), eq[1].trim());
    else flags.add(p);
  }
  return { named, flags };
}

/** Splits `key = value` on the first top-level `=` that is not part of `==`, `=>` or inside a string. */
function splitEqOutsideStr(p: string): [string, string] | undefined {
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[' || c === '<' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '>' || c === '}') depth--;
    else if (c === '=' && depth === 0 && p[i + 1] !== '=' && p[i + 1] !== '>' && p[i - 1] !== '!' && p[i - 1] !== '<' && p[i - 1] !== '>') {
      return [p.slice(0, i), p.slice(i + 1)];
    }
  }
  return undefined;
}

export interface RustField {
  name: string;
  /** Type as written with a leading `Option<…>` unwrapped. */
  type: string;
  /** `Option<T>` field. */
  optional: boolean;
  /** Inner text of the field's `#[sea_orm(…)]` attribute, or `''`. */
  seaOrm: string;
  line: number;
}

const RUST_FIELD_RE = /^(?:pub\s*(?:\([^)]*\)\s*)?)?(?:r#)?([A-Za-z_]\w*)\s*:\s*([\s\S]+?)\s*$/;
const OPTION_RE = /^Option\s*<\s*([\s\S]+?)\s*>$/;

/** Parses the named fields of the Rust struct whose `{` is at `open`. */
export function rustStructFields(code: Code, open: number): RustField[] {
  const out: RustField[] = [];
  for (const item of code.items(open)) {
    const seaOrm = extractSeaOrm(item.text);
    const decl = stripAttrs(item.text).trim();
    const m = RUST_FIELD_RE.exec(decl);
    if (!m) continue;
    let type = m[2].trim();
    const opt = OPTION_RE.exec(type);
    const optional = !!opt;
    if (opt) type = opt[1].trim();
    out.push({ name: m[1], type, optional, seaOrm, line: code.lineAt(item.start) });
  }
  return out;
}

export interface RustVariant {
  name: string;
  /** Inner text of the variant's `#[sea_orm(…)]` attribute, or `''`. */
  seaOrm: string;
  line: number;
}

/** Parses the variants of the Rust enum whose `{` is at `open`. */
export function rustEnumVariants(code: Code, open: number): RustVariant[] {
  const out: RustVariant[] = [];
  for (const item of code.items(open)) {
    const seaOrm = extractSeaOrm(item.text);
    const decl = stripAttrs(item.text).trim();
    const m = /^([A-Za-z_]\w*)/.exec(decl);
    if (!m) continue;
    out.push({ name: m[1], seaOrm, line: code.lineAt(item.start) });
  }
  return out;
}

function extractSeaOrm(text: string): string {
  const m = SEAORM_ATTR_RE.exec(text);
  return m ? m[1] : '';
}

function stripAttrs(text: string): string {
  return text.replace(/#!?\[[\s\S]*?\]/g, ' ');
}
