/**
 * JetBrains Exposed parser (Kotlin SQL DSL).
 *
 * Reads table definitions written as `object Users : IntIdTable("users") { … }`, their column
 * declarations (`val name = varchar("name", 50).nullable()`), foreign keys (`reference` /
 * `optReference`), primary keys (`IntIdTable` id + `override val primaryKey = PrimaryKey(…)`) and
 * `init { index(…) }` indexes. DAO entity classes (`IntEntity`) are ignored.
 *
 * Pure, synchronous TypeScript — no Node APIs. Never throws.
 */

import type { Column, IndexDef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { Code, numberValue, stringValue } from '../core/text';
import { splitAngle } from './shared/jvmnet';

const WORD_RE = /^[A-Za-z_]\w*/;

/** Base classes that make an `object` an Exposed table, mapped to the implicit `id` column type. */
const ID_TABLE_TYPES: Readonly<Record<string, string>> = {
  IntIdTable: 'integer',
  LongIdTable: 'long',
  UIntIdTable: 'uinteger',
  ULongIdTable: 'ulong',
  UUIDTable: 'uuid',
};

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  code: Code;
  file: string;
  enumNames: Set<string>;
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const code = new Code(file.text, 'kotlin');
  const ctx: Ctx = { code, file: file.path, enumNames: new Set() };

  for (const en of findEnums(code)) {
    ctx.enumNames.add(en.name);
    result.enums.push({ name: en.name, values: en.values, source: sourceRef(file, code.lineAt(en.at)) });
  }

  const m = code.masked;
  const re = /\bobject\s+([A-Za-z_]\w*)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const name = mt[1];
    const afterName = mt.index + mt[0].length;
    const bodyOpen = findBrace(code, afterName);
    const header = code.slice(afterName, bodyOpen >= 0 ? bodyOpen : afterName);
    const sup = tableSupertype(header);
    if (!sup) continue; // not a table object (e.g. a plain singleton or DAO companion)
    const bodyClose = bodyOpen >= 0 ? code.closing(bodyOpen) : -1;
    emitTable(ctx, result, name, mt.index, sup, bodyOpen, bodyClose);
    re.lastIndex = bodyClose > bodyOpen ? bodyClose : afterName;
  }
  return result;
}

interface Supertype {
  base: string;
  explicitName?: string;
  idType?: string;
  hasId: boolean;
}

/** Reads the first supertype of an `object` and decides whether it is an Exposed table. */
function tableSupertype(header: string): Supertype | undefined {
  const colon = header.indexOf(':');
  if (colon < 0) return undefined;
  const first = splitAngle(header.slice(colon + 1)).shift();
  if (!first) return undefined;
  const sm = /^([A-Za-z_][\w.]*)\s*(?:<([^>]*)>)?\s*(\(([\s\S]*)\))?/.exec(first.trim());
  if (!sm) return undefined;
  const base = sm[1].split('.').pop() ?? sm[1];
  const generic = sm[2];
  const argText = sm[4] ?? '';
  const explicitName = firstStringArg(argText);
  if (base in ID_TABLE_TYPES) return { base, explicitName, idType: ID_TABLE_TYPES[base], hasId: true };
  if (base === 'IdTable') return { base, explicitName, idType: generic ? generic.trim() : '', hasId: true };
  if (base === 'Table' || /Table$/.test(base)) return { base, explicitName, hasId: false };
  return undefined;
}

function firstStringArg(argText: string): string | undefined {
  const parts = splitAngle(argText);
  for (const p of parts) {
    const s = stringValue(p.trim());
    if (s !== undefined) return s;
  }
  return undefined;
}

function emitTable(
  ctx: Ctx,
  result: ParseResult,
  objectName: string,
  declAt: number,
  sup: Supertype,
  bodyOpen: number,
  bodyClose: number,
): void {
  const { code, file } = ctx;
  const tableName = sup.explicitName ?? objectName.replace(/Table$/, '');
  const certainty: 0 | 2 = sup.explicitName ? 2 : 0;

  const columns: Column[] = [];
  const byProp = new Map<string, Column>();
  const relations: RawRelation[] = [];
  const indexes: IndexDef[] = [];

  if (sup.hasId) {
    const id = column('id', normalizeIdType(sup.idType), { primaryKey: true, nullable: false, generated: true, source: sourceRef(file, code.lineAt(declAt)) });
    columns.push(id);
    byProp.set('id', id);
  }

  if (bodyOpen >= 0 && bodyClose > bodyOpen) {
    walkBody(ctx, objectName, bodyOpen + 1, bodyClose, { columns, byProp, relations, indexes });
  }

  const entity: RawEntity = {
    name: tableName,
    kind: 'table',
    modelName: objectName,
    nameCertainty: certainty,
    columns,
    source: sourceRef(file, code.lineAt(declAt)),
  };
  if (indexes.length) entity.indexes = indexes;
  result.entities.push(entity);
  result.relations.push(...relations);
}

function normalizeIdType(t: string | undefined): string {
  if (!t) return '';
  const simple = t.split('.').pop() ?? t;
  const map: Record<string, string> = { Int: 'integer', Long: 'long', UUID: 'uuid', UInt: 'uinteger', ULong: 'ulong' };
  return map[simple] ?? simple.toLowerCase();
}

interface Acc {
  columns: Column[];
  byProp: Map<string, Column>;
  relations: RawRelation[];
  indexes: IndexDef[];
}

function walkBody(ctx: Ctx, objectName: string, start: number, end: number, acc: Acc): void {
  const { code } = ctx;
  const m = code.masked;
  let pos = start;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const w = WORD_RE.exec(m.slice(pos, pos + 32));
    if (!w) {
      if (m[pos] === '{' || m[pos] === '(' || m[pos] === '[') {
        const cl = code.closing(pos);
        pos = cl < 0 ? end : cl + 1;
      } else pos++;
      continue;
    }
    const word = w[0];
    if (word === 'init') {
      const brace = findBrace(code, pos + word.length);
      if (brace >= 0) {
        const close = code.closing(brace);
        parseInit(ctx, brace + 1, close < 0 ? end : close, acc);
        pos = close < 0 ? end : close + 1;
        continue;
      }
    }
    if (word === 'val' || word === 'var' || (word === 'override' && /\boverride\s+val\b/.test(m.slice(pos, pos + 16)))) {
      const kw = /^(?:override\s+)?(?:val|var)\b/.exec(m.slice(pos, pos + 20));
      let i = pos + (kw ? kw[0].length : 3);
      while (i < end && isWs(m[i])) i++;
      const nm = /^([A-Za-z_]\w*)/.exec(m.slice(i, i + 80));
      if (!nm) {
        pos = i + 1;
        continue;
      }
      const propName = nm[1];
      i += nm[0].length;
      while (i < end && isWs(m[i])) i++;
      if (m[i] !== '=') {
        pos = i;
        continue;
      }
      i++;
      const exprStart = i;
      const exprEnd = exprEndOf(code, exprStart, end);
      if (propName === 'primaryKey') applyPrimaryKey(code, exprStart, exprEnd, acc);
      else parseColumn(ctx, objectName, propName, pos, exprStart, exprEnd, acc);
      pos = exprEnd;
      continue;
    }
    pos += word.length;
  }
}

/** End of a `val x = …` right-hand side: a depth-0 newline that is not followed by a chained `.`. */
function exprEndOf(code: Code, from: number, limit: number): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === '\n') {
      let p = i - 1;
      while (p >= from && (m[p] === ' ' || m[p] === '\t' || m[p] === '\r')) p--;
      const prev = m[p];
      if (prev === '.' || prev === '(' || prev === ',' || prev === '{') continue;
      let q = i + 1;
      while (q < limit && isWs(m[q])) q++;
      if (m[q] === '.' || m[q] === ')') continue;
      return i;
    }
  }
  return limit;
}

const REFERENCE_FNS = new Set(['reference', 'optReference', 'references', 'optReferences']);

function parseColumn(
  ctx: Ctx,
  objectName: string,
  propName: string,
  declPos: number,
  exprStart: number,
  exprEnd: number,
  acc: Acc,
): void {
  const { code, file } = ctx;
  const expr = code.slice(exprStart, exprEnd);
  const head = headCall(code, exprStart, exprEnd);
  const line = code.lineAt(declPos);
  const src = sourceRef(file, line);

  const nullable = /\.nullable\s*\(/.test(expr);
  const unique = /\.uniqueIndex\s*\(/.test(expr);
  const autoInc = /\.autoIncrement\s*\(/.test(expr);

  // Foreign keys declared as the head call: `reference("city_id", Cities)` / `optReference(…)`.
  if (head && REFERENCE_FNS.has(head.name)) {
    emitReference(ctx, objectName, propName, head, nullable || head.name.startsWith('opt'), src, acc);
    return;
  }

  let name = head ? firstPositionalString(code, head.open) : undefined;
  if (!name) name = propName;
  const type = columnType(code, head);
  const col = column(name, type, { nullable, unique, source: src });
  if (autoInc) col.generated = true;
  const def = chainArg(code, exprStart, exprEnd, 'default') ?? chainArg(code, exprStart, exprEnd, 'defaultExpression');
  if (def !== undefined) col.default = def;
  if (head && isEnumFn(head.name)) {
    const en = enumClassArg(code, head.open);
    if (en) {
      col.type = en;
      if (ctx.enumNames.has(en)) col.enumRef = en;
    }
  }
  acc.columns.push(col);
  acc.byProp.set(propName, col);
  if (/\.index\s*\(/.test(expr) && !unique) acc.indexes.push({ columns: [name], unique: false, source: src });

  // A column may still carry a `.references(Other.id)` modifier.
  const refOpen = findChainCall(code, exprStart, exprEnd, 'references') ?? findChainCall(code, exprStart, exprEnd, 'optReferences');
  if (refOpen !== null) emitChainReference(ctx, objectName, name, refOpen, nullable, src, acc);
}

function emitReference(
  ctx: Ctx,
  objectName: string,
  propName: string,
  head: { name: string; open: number },
  nullable: boolean,
  src: { file: string; line: number },
  acc: Acc,
): void {
  const args = ctx.code.args(head.open);
  const name = args.positional[0] ? stringValue(args.positional[0].text) ?? propName : propName;
  const targetText = args.positional[1]?.text ?? '';
  const { table, column: toCol } = refTarget(targetText);
  const onDelete = refOption(args.named.get('onDelete')?.text);
  const onUpdate = refOption(args.named.get('onUpdate')?.text);
  const col = column(name, '', { nullable, source: src });
  acc.columns.push(col);
  acc.byProp.set(propName, col);
  if (!table) return;
  const rel: RawRelation = {
    from: { model: objectName },
    fromColumns: [name],
    to: { model: table },
    toColumns: toCol ? [toCol] : [],
    cardinality: 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: src,
  };
  if (onDelete) rel.onDelete = onDelete;
  if (onUpdate) rel.onUpdate = onUpdate;
  acc.relations.push(rel);
}

function emitChainReference(
  ctx: Ctx,
  objectName: string,
  colName: string,
  open: number,
  nullable: boolean,
  src: { file: string; line: number },
  acc: Acc,
): void {
  const args = ctx.code.args(open);
  const targetText = args.positional[0]?.text ?? '';
  const { table, column: toCol } = refTarget(targetText);
  if (!table) return;
  const onDelete = refOption(args.named.get('onDelete')?.text);
  const rel: RawRelation = {
    from: { model: objectName },
    fromColumns: [colName],
    to: { model: table },
    toColumns: toCol ? [toCol] : [],
    cardinality: 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: src,
  };
  if (onDelete) rel.onDelete = onDelete;
  acc.relations.push(rel);
}

/** `Cities` → table only; `Other.id` → table + referenced column. */
function refTarget(text: string): { table?: string; column?: string } {
  const t = text.trim().replace(/::class$/, '');
  if (!t) return {};
  const parts = t.split('.');
  if (parts.length >= 2) return { table: parts[0], column: parts[1] };
  return { table: parts[0] };
}

function refOption(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /ReferenceOption\.(\w+)/.exec(text) ?? /(\w+)\s*$/.exec(text.trim());
  return m ? m[1] : undefined;
}

interface HeadCall {
  name: string;
  open: number;
}

/** The first function call in an expression (`varchar(…)` in `varchar(…).nullable()`). */
function headCall(code: Code, from: number, to: number): HeadCall | undefined {
  const m = code.masked;
  for (let i = from; i < to; i++) {
    if (m[i] === '(') {
      let j = i - 1;
      while (j >= from && isWs(m[j])) j--;
      const nameEnd = j + 1;
      while (j >= from && /[\w$]/.test(m[j])) j--;
      const name = m.slice(j + 1, nameEnd);
      return name ? { name, open: i } : undefined;
    }
    if (m[i] === '.' || m[i] === ')' || m[i] === '\n') {
      if (m[i] === ')') return undefined;
    }
  }
  return undefined;
}

/** Offset of the `(` of a chained call `.name(` within `[from, to)`. */
function findChainCall(code: Code, from: number, to: number, name: string): number | null {
  const m = code.masked;
  const needle = '.' + name;
  // Search only inside [from, to): an unbounded indexOf scans the rest of the file on every miss,
  // which made large files quadratic.
  const range = m.slice(from, to);
  let i = 0;
  for (;;) {
    const rel = range.indexOf(needle, i);
    if (rel < 0) return null;
    const at = from + rel;
    let q = at + needle.length;
    while (q < to && isWs(m[q])) q++;
    if (m[q] === '(') return q;
    i = rel + needle.length;
  }
}

function firstPositionalString(code: Code, open: number): string | undefined {
  const pos = code.args(open).positional;
  return pos.length ? stringValue(pos[0].text) : undefined;
}

function chainArg(code: Code, from: number, to: number, name: string): string | undefined {
  const open = findChainCall(code, from, to, name);
  if (open === null) return undefined;
  const pos = code.args(open).positional;
  if (!pos.length) return undefined;
  const str = stringValue(pos[0].text);
  return str !== undefined ? str : pos[0].text;
}

const ENUM_FNS = new Set(['enumeration', 'enumerationByName', 'customEnumeration']);
function isEnumFn(name: string): boolean {
  return ENUM_FNS.has(name);
}

function enumClassArg(code: Code, open: number): string | undefined {
  for (const p of code.args(open).positional) {
    const em = /([A-Za-z_]\w*)::class/.exec(p.text);
    if (em) return em[1];
  }
  return undefined;
}

function columnType(code: Code, head: HeadCall | undefined): string {
  if (!head) return '';
  const fn = head.name;
  const pos = code.args(head.open).positional;
  if (fn === 'varchar' || fn === 'char' || fn === 'binary' || fn === 'varbinary') {
    const len = pos[1] ? numberValue(pos[1].text) : undefined;
    return len !== undefined ? `${fn}(${len})` : fn;
  }
  if (fn === 'decimal') {
    const a = pos[1] ? numberValue(pos[1].text) : undefined;
    const b = pos[2] ? numberValue(pos[2].text) : undefined;
    return a !== undefined && b !== undefined ? `decimal(${a}, ${b})` : 'decimal';
  }
  if (REFERENCE_FNS.has(fn)) return '';
  return fn;
}

function applyPrimaryKey(code: Code, from: number, to: number, acc: Acc): void {
  const open = code.masked.indexOf('(', from);
  if (open < 0 || open >= to) return;
  for (const p of code.args(open).positional) {
    const idm = /^([A-Za-z_]\w*)/.exec(p.text.replace(/^[A-Za-z_][\w.]*\./, ''));
    const prop = idm ? idm[1] : undefined;
    const col = prop ? acc.byProp.get(prop) : undefined;
    if (col) {
      col.primaryKey = true;
      col.nullable = false;
    }
  }
}

function parseInit(ctx: Ctx, from: number, to: number, acc: Acc): void {
  for (const unique of [false, true]) {
    const fn = unique ? 'uniqueIndex' : 'index';
    const m = ctx.code.masked;
    let i = from;
    for (;;) {
      const at = indexOfCall(m, fn, i, to);
      if (at < 0) break;
      const open = at + fn.length;
      const cols: string[] = [];
      for (const p of ctx.code.args(open).positional) {
        const idm = /([A-Za-z_]\w*)\s*$/.exec(p.text.replace(/\s*=.*/, '')); // column property reference
        const prop = idm ? idm[1] : undefined;
        const col = prop ? acc.byProp.get(prop) : undefined;
        if (col) cols.push(col.name);
      }
      if (cols.length) acc.indexes.push({ columns: cols, unique, source: sourceRef(ctx.file, ctx.code.lineAt(at)) });
      i = open + 1;
    }
  }
}

/** Finds `name(` as a whole identifier (not a method suffix like `uniqueIndex` matching `index`). */
function indexOfCall(m: string, name: string, from: number, to: number): number {
  let i = from;
  for (;;) {
    const at = m.indexOf(name + '(', i);
    if (at < 0 || at >= to) return -1;
    const before = m[at - 1];
    if (before === undefined || !/[\w$.]/.test(before)) return at;
    i = at + name.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Enums + helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function findEnums(code: Code): { name: string; values: string[]; at: number }[] {
  const m = code.masked;
  const out: { name: string; values: string[]; at: number }[] = [];
  const re = /\benum\s+class\s+([A-Za-z_]\w*)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const brace = findBrace(code, mt.index + mt[0].length);
    if (brace < 0) continue;
    const close = code.closing(brace);
    if (close < 0) continue;
    const values: string[] = [];
    let end = close;
    const semi = firstAtDepth0(code, brace + 1, close, ';');
    if (semi >= 0) end = semi;
    for (const part of code.split(brace + 1, end, ',')) {
      const idm = /^[A-Za-z_]\w*/.exec(part.text);
      if (idm) values.push(idm[0]);
    }
    if (values.length) out.push({ name: mt[1], values, at: mt.index });
  }
  return out;
}

/** First `{` at bracket depth 0 after `from` (skipping `(…)` / `[…]`), or -1. */
function findBrace(code: Code, from: number): number {
  const m = code.masked;
  for (let i = from; i < m.length; i++) {
    const c = m[i];
    if (c === '(' || c === '[') {
      const cl = code.closing(i);
      i = cl < 0 ? m.length : cl;
      continue;
    }
    if (c === '{') return i;
    if (c === '}' || c === ';') return -1;
  }
  return -1;
}

function firstAtDepth0(code: Code, from: number, to: number, ch: string): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (depth === 0 && c === ch) return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Detect + export
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/@Entity\b/.test(t)) return false; // JPA, not Exposed
  if (/\borg\.jetbrains\.exposed\b/.test(t)) return true;
  return /\bobject\s+\w+\s*:\s*[\w.]*(?:Table|IdTable)\b/.test(t);
}

export const exposedParser: SchemaParser = {
  kind: 'exposed',
  extensions: ['.kt'],
  detect,
  parse,
};
