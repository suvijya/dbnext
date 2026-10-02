/**
 * EF Core parser (C#). Handles the four kinds of files an EF Core project contains:
 *
 *  a) Entity POCO classes / records  → `candidate` entities with their scalar properties and
 *     navigation-property relations (data annotations + conventions).
 *  b) `DbContext` subclasses         → `DbSet<T>` partial entities + `OnModelCreating` fluent API,
 *     plus `IEntityTypeConfiguration<T>` classes. Engine from `UseNpgsql` / `UseSqlServer` / …
 *  c) `Migrations/*.cs : Migration`  → the `Up()` method only (origin `migration`).
 *  d) `*ModelSnapshot.cs`            → the current model (definition, non-candidate entities).
 *
 * Pure, synchronous TypeScript — no Node APIs. Never throws.
 */

import type {
  Column,
  ColumnPatch,
  EngineHint,
  IndexDef,
  ParseResult,
  RawEntity,
  RawRelation,
  SchemaOp,
  SourceFile,
  SourceRef,
} from '../core/model';
import { baseName, column, sourceRef, type SchemaParser } from '../core/parser';
import { shortName, singularize } from '../core/naming';
import { Code, boolValue, stringValue } from '../core/text';
import { collectionElement, simpleName, splitAngle } from './shared/jvmnet';

const WORD_RE = /^[A-Za-z_]\w*/;

const CS_VALUE_TYPES = new Set([
  'int',
  'long',
  'short',
  'byte',
  'sbyte',
  'uint',
  'ulong',
  'ushort',
  'nint',
  'nuint',
  'bool',
  'char',
  'float',
  'double',
  'decimal',
  'Guid',
  'DateTime',
  'DateTimeOffset',
  'TimeSpan',
  'DateOnly',
  'TimeOnly',
  'Int32',
  'Int64',
  'Int16',
  'Boolean',
  'Decimal',
  'Double',
  'Single',
]);

const CS_SCALARS = new Set([...CS_VALUE_TYPES, 'string', 'String', 'object']);

const CS_TYPE_KEYWORDS = new Set(['class', 'struct', 'record', 'interface', 'enum']);
const CS_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'abstract',
  'sealed',
  'partial',
  'virtual',
  'override',
  'readonly',
  'const',
  'async',
  'unsafe',
  'extern',
  'new',
  'volatile',
  'required',
  'file',
  'ref',
]);

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'csharp');
  const base = baseName(file.path).toLowerCase();
  if (base.endsWith('.designer.cs')) return emptyDefinition();
  if (base.endsWith('modelsnapshot.cs') || (/\bModelSnapshot\b/.test(file.text) && /:\s*ModelSnapshot\b/.test(file.text))) {
    return parseSnapshot(code, file);
  }
  if (isMigration(file)) return parseMigration(code, file);
  return parseDefinition(code, file);
}

function emptyDefinition(): ParseResult {
  return { origin: 'definition', entities: [], relations: [], enums: [] };
}

function isMigration(file: SourceFile): boolean {
  return /:\s*Migration\b/.test(file.text) && /migrationBuilder/.test(file.text);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// C# type discovery
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface CsAttr {
  name: string;
  open: number;
}

interface CsType {
  name: string;
  keyword: string;
  isEnum: boolean;
  attributes: CsAttr[];
  baseNames: string[];
  bodyOpen: number;
  bodyClose: number;
  afterName: number;
  headerEnd: number;
  recordOpen: number;
  declStart: number;
  configGeneric?: string;
}

function discoverCsTypes(code: Code): CsType[] {
  const out: CsType[] = [];
  walkCs(code, 0, code.masked.length, out);
  return out;
}

function walkCs(code: Code, start: number, end: number, out: CsType[]): void {
  const m = code.masked;
  let pos = start;
  let pending: CsAttr[] = [];
  let pendingStart = -1;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const c = m[pos];
    if (c === '[') {
      const close = code.closing(pos);
      if (close < 0) break;
      if (pendingStart < 0) pendingStart = pos;
      pending.push(...readCsAttrGroup(code, pos, close));
      pos = close + 1;
      continue;
    }
    const w = WORD_RE.exec(m.slice(pos, pos + 40));
    if (!w) {
      if (c === '{' || c === '(') {
        const cl = code.closing(pos);
        pos = cl < 0 ? end : cl + 1;
      } else pos++;
      pending = [];
      pendingStart = -1;
      continue;
    }
    const word = w[0];
    if (CS_TYPE_KEYWORDS.has(word)) {
      let after = pos + word.length;
      const rk = /^\s+(class|struct)\b/.exec(m.slice(after, after + 12));
      if (word === 'record' && rk) after += rk[0].length;
      const hasName = /^\s+[A-Za-z_]\w*/.test(m.slice(after, after + 100));
      if (hasName) {
        const decl = parseCsType(code, pos, word, end, pending, pendingStart);
        out.push(decl);
        if (decl.bodyOpen >= 0 && decl.bodyClose > decl.bodyOpen) walkCs(code, decl.bodyOpen + 1, decl.bodyClose, out);
        pos = decl.bodyOpen >= 0 && decl.bodyClose >= 0 ? decl.bodyClose + 1 : decl.headerEnd;
        pending = [];
        pendingStart = -1;
        continue;
      }
    }
    pos += word.length;
    if (!CS_MODIFIERS.has(word)) {
      pending = [];
      pendingStart = -1;
    }
  }
}

function readCsAttrGroup(code: Code, open: number, close: number): CsAttr[] {
  const out: CsAttr[] = [];
  for (const part of code.split(open + 1, close, ',')) {
    const text = part.text.replace(/^(?:assembly|module|type|property|field|method|param|return|event)\s*:\s*/, '');
    const nm = /^([A-Za-z_][\w.]*)/.exec(text);
    if (!nm) continue;
    const name = simpleName(nm[1]);
    const parenRel = part.text.indexOf('(');
    const openOffset = parenRel >= 0 ? part.start + parenRel : -1;
    out.push({ name, open: openOffset >= 0 && openOffset < part.end ? openOffset : -1 });
  }
  return out;
}

function parseCsType(code: Code, kwPos: number, keyword: string, limit: number, attributes: CsAttr[], pendingStart: number): CsType {
  const m = code.masked;
  let after = kwPos + keyword.length;
  // `record class` / `record struct`
  const rk = /^\s+(class|struct)\b/.exec(m.slice(after, after + 12));
  if (keyword === 'record' && rk) after += rk[0].length;
  const nm = /^\s+([A-Za-z_]\w*)/.exec(m.slice(after, after + 100));
  const name = nm ? nm[1] : '';
  const afterName = nm ? after + nm[0].length : after;
  const bodyOpen = csTypeBody(code, afterName, limit);
  const bodyClose = bodyOpen >= 0 ? code.closing(bodyOpen) : -1;
  const headerEnd = bodyOpen >= 0 ? bodyOpen : csHeaderStop(code, afterName, limit);
  const colon = firstAtDepth0(code, afterName, headerEnd, ':');
  const recordOpen = firstAtDepth0(code, afterName, colon >= 0 ? colon : headerEnd, '(');
  const baseNames = colon >= 0 ? parseBaseList(code, colon + 1, headerEnd) : [];
  let configGeneric: string | undefined;
  if (colon >= 0) {
    const cm = /IEntityTypeConfiguration\s*<([^>]+)>/.exec(code.slice(colon + 1, headerEnd));
    if (cm) configGeneric = simpleName(cm[1]);
  }
  return {
    name,
    keyword,
    isEnum: keyword === 'enum',
    attributes,
    baseNames,
    bodyOpen,
    bodyClose,
    afterName,
    headerEnd,
    recordOpen,
    declStart: attributes.length && pendingStart >= 0 ? pendingStart : kwPos,
    configGeneric,
  };
}

function csTypeBody(code: Code, from: number, limit: number): number {
  const m = code.masked;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[') {
      const cl = code.closing(i);
      i = cl < 0 ? limit : cl;
      continue;
    }
    if (c === '{') return i;
    if (c === ';') return -1; // record with no body
  }
  return -1;
}

function csHeaderStop(code: Code, from: number, limit: number): number {
  const semi = firstAtDepth0(code, from, limit, ';');
  return semi >= 0 ? semi : limit;
}

function parseBaseList(code: Code, from: number, to: number): string[] {
  const text = code.slice(from, to);
  // `: DbContext(options)` (C# 12 primary constructors pass base arguments) → `DbContext`
  return splitAngle(stripAngles(stripParens(text))).map((s) => simpleName(s.trim())).filter(Boolean);
}

function stripParens(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

function stripAngles(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
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
// Shared attribute / call helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function findAttr(attrs: readonly CsAttr[], name: string): CsAttr | undefined {
  return attrs.find((a) => a.name === name || a.name === name + 'Attribute');
}
function hasAttr(attrs: readonly CsAttr[], name: string): boolean {
  return !!findAttr(attrs, name);
}

function attrString(code: Code, attr: CsAttr | undefined, key?: string): string | undefined {
  if (!attr || attr.open < 0) return undefined;
  const args = code.args(attr.open);
  if (key) {
    const span = args.named.get(key);
    return span ? stringValue(span.text) : undefined;
  }
  return args.positional.length ? stringValue(args.positional[0].text) : undefined;
}

function attrBool(code: Code, attr: CsAttr | undefined, key: string): boolean | undefined {
  if (!attr || attr.open < 0) return undefined;
  const span = code.args(attr.open).named.get(key);
  return span ? boolValue(span.text) : undefined;
}

interface Call {
  name: string;
  generic?: string;
  open: number;
}

/** Parses the chain of top-level `.Method<…>(…)` calls in `[from, to)`, skipping nested args. */
function chainCalls(code: Code, from: number, to: number): Call[] {
  const m = code.masked;
  const out: Call[] = [];
  let i = from;
  while (i < to) {
    const c = m[i];
    if (c === '.' && /[A-Za-z_]/.test(m[i + 1] ?? '')) {
      const nm = WORD_RE.exec(m.slice(i + 1, i + 60));
      if (nm) {
        let j = i + 1 + nm[0].length;
        let generic: string | undefined;
        while (j < to && isWs(m[j])) j++;
        if (m[j] === '<') {
          const gc = code.closing(j);
          if (gc > 0 && gc < to) {
            generic = code.slice(j + 1, gc);
            j = gc + 1;
            while (j < to && isWs(m[j])) j++;
          }
        }
        if (m[j] === '(') {
          out.push({ name: nm[0], generic, open: j });
          const cl = code.closing(j);
          i = cl < 0 ? to : cl + 1;
          continue;
        }
        i = i + 1 + nm[0].length;
        continue;
      }
    }
    if (c === '(' || c === '[' || c === '{') {
      const cl = code.closing(i);
      i = cl < 0 ? to : cl + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Column / property names referenced by an argument: lambdas, `new {…}`, strings, `nameof`, `new[]{…}`. */
function propsFromArg(text: string): string[] {
  let body = text.trim();
  const arrow = topLevelArrow(body);
  if (arrow >= 0) body = body.slice(arrow + 2).trim();
  const nm = /new\b[^{]*\{([\s\S]*)\}/.exec(body);
  const inner = nm ? nm[1] : body;
  return splitAngle(inner)
    .map(cleanProp)
    .filter((s): s is string => !!s);
}

function cleanProp(s: string): string | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const str = stringValue(t);
  if (str !== undefined) return str;
  const no = /nameof\s*\(\s*([\w.]+)\s*\)/.exec(t);
  if (no) return no[1].split('.').pop();
  const idm = /([A-Za-z_]\w*)\s*$/.exec(t.replace(/\s*=.*$/, ''));
  return idm ? idm[1] : undefined;
}

function topLevelArrow(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '=' && s[i + 1] === '>') return i;
  }
  return -1;
}

/** All property names across every positional argument of a call. */
function callProps(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const p of code.args(open).positional) out.push(...propsFromArg(p.text));
  return out;
}

function deleteBehavior(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /(?:DeleteBehavior|ReferentialAction)\.(\w+)/.exec(text) ?? /(\w+)\s*$/.exec(text.trim());
  if (!m) return undefined;
  const map: Record<string, string> = {
    Cascade: 'CASCADE',
    Restrict: 'RESTRICT',
    ClientSetNull: 'SET NULL',
    SetNull: 'SET NULL',
    NoAction: 'NO ACTION',
    SetDefault: 'SET DEFAULT',
  };
  return map[m[1]] ?? m[1];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a) + (b) definition files: entity classes, DbContext, configurations
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Def {
  code: Code;
  file: string;
  result: ParseResult;
  enumNames: Set<string>;
}

function parseDefinition(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const def: Def = { code, file: file.path, result, enumNames: new Set() };
  const types = discoverCsTypes(code);

  for (const t of types) if (t.isEnum) def.enumNames.add(t.name);
  for (const t of types) if (t.isEnum) emitCsEnum(def, t);

  collectEngineHints(code, file.path, result);

  for (const t of types) {
    if (t.isEnum || t.keyword === 'interface') continue;
    if (isDbContext(t)) parseDbContext(def, t);
    else if (implementsConfig(t)) parseConfigClass(def, t);
    else if (!hasAttr(t.attributes, 'Owned')) emitEntityClass(def, t);
  }
  return result;
}

function isDbContext(t: CsType): boolean {
  return t.baseNames.some((b) => /DbContext$/.test(b));
}
function implementsConfig(t: CsType): boolean {
  return t.baseNames.some((b) => b === 'IEntityTypeConfiguration');
}

function emitCsEnum(def: Def, t: CsType): void {
  if (t.bodyOpen < 0 || t.bodyClose < 0) return;
  const values: string[] = [];
  for (const part of def.code.split(t.bodyOpen + 1, t.bodyClose, ',')) {
    const idm = /^[A-Za-z_]\w*/.exec(part.text);
    if (idm) values.push(idm[0]);
  }
  if (values.length) def.result.enums.push({ name: t.name, values, source: sourceRef(def.file, def.code.lineAt(t.declStart)) });
}

// ── entity POCO classes ──

interface Prop {
  name: string;
  type: string;
  attrs: CsAttr[];
  memberStart: number;
  initializer?: string;
}

function emitEntityClass(def: Def, t: CsType): void {
  const { code, file } = def;
  const tableAttr = findAttr(t.attributes, 'Table');
  const tableName = tableAttr ? attrString(code, tableAttr) : undefined;
  const schema = attrString(code, tableAttr, 'Schema');
  const name = tableName ?? t.name;
  const certainty: 0 | 2 = tableName ? 2 : 0;

  const props = csProperties(def, t);
  const scalars: Column[] = [];
  const navs: Prop[] = [];
  for (const p of props) {
    if (hasAttr(p.attrs, 'NotMapped')) continue;
    if (isNavigation(def, p)) navs.push(p);
    else scalars.push(buildScalar(def, p));
  }
  applyPkConvention(code, t, scalars);

  const entity: RawEntity = {
    name,
    kind: 'table',
    modelName: t.name,
    nameCertainty: certainty,
    columns: scalars,
    candidate: true,
    source: sourceRef(file, code.lineAt(t.declStart)),
  };
  if (schema) entity.schema = schema;
  const extendsBases = t.baseNames.filter((b) => b !== 'IEntityTypeConfiguration' && !/DbContext$/.test(b));
  if (extendsBases.length) entity.extends = extendsBases;
  const idx = classIndexes(def, t);
  if (idx.length) entity.indexes = idx;
  def.result.entities.push(entity);

  for (const nav of navs) emitNavigation(def, t, nav, scalars);
}

function csProperties(def: Def, t: CsType): Prop[] {
  const out: Prop[] = [];
  if (t.recordOpen >= 0) out.push(...recordParams(def, t.recordOpen));
  if (t.bodyOpen >= 0 && t.bodyClose > t.bodyOpen) out.push(...bodyProps(def, t.bodyOpen + 1, t.bodyClose));
  return out;
}

function recordParams(def: Def, open: number): Prop[] {
  const { code } = def;
  const out: Prop[] = [];
  for (const item of code.items(open)) {
    const { attributes, declStart } = readLeadingAttrs(code, item.start, item.end);
    const decl = code.slice(declStart, item.end).trim();
    const parsed = parseDeclarator(decl);
    if (parsed) out.push({ name: parsed.name, type: parsed.type, attrs: attributes, memberStart: item.start });
  }
  return out;
}

function readLeadingAttrs(code: Code, from: number, limit: number): { attributes: CsAttr[]; declStart: number } {
  const m = code.masked;
  const attributes: CsAttr[] = [];
  let i = from;
  for (;;) {
    while (i < limit && isWs(m[i])) i++;
    if (m[i] === '[') {
      const close = code.closing(i);
      if (close < 0 || close >= limit) break;
      attributes.push(...readCsAttrGroup(code, i, close));
      i = close + 1;
      continue;
    }
    const w = WORD_RE.exec(m.slice(i, Math.min(limit, i + 32)));
    if (w && CS_MODIFIERS.has(w[0])) {
      i += w[0].length;
      continue;
    }
    break;
  }
  return { attributes, declStart: i };
}

function bodyProps(def: Def, start: number, end: number): Prop[] {
  const { code } = def;
  const m = code.masked;
  const out: Prop[] = [];
  let pos = start;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const memberStart = pos;
    const { attributes, declStart } = readLeadingAttrs(code, pos, end);
    const info = classifyMember(code, declStart, end);
    if (!info) {
      pos = Math.max(declStart + 1, pos + 1);
      continue;
    }
    pos = info.memberEnd;
    if (info.kind === 'skip') continue;
    const parsed = parseDeclarator(code.slice(declStart, info.declEnd));
    if (!parsed) continue;
    out.push({ name: parsed.name, type: parsed.type, attrs: attributes, memberStart, initializer: info.initializer });
  }
  return out;
}

interface MemberInfo {
  kind: 'prop' | 'field' | 'skip';
  declEnd: number;
  memberEnd: number;
  initializer?: string;
}

function classifyMember(code: Code, declStart: number, end: number): MemberInfo | undefined {
  const m = code.masked;
  let depth = 0;
  for (let i = declStart; i < end; i++) {
    const c = m[i];
    if (depth === 0) {
      if (c === '(') return skipMethod(code, i, end);
      if (c === '{') return propAccessor(code, declStart, i, end);
      if (c === ';') return { kind: 'field', declEnd: i, memberEnd: i + 1 };
      if (c === '=' && m[i + 1] === '>') return exprMember(code, declStart, i, end);
      if (c === '=') return fieldInit(code, i, end);
    }
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return undefined;
}

function skipMethod(code: Code, open: number, end: number): MemberInfo {
  const m = code.masked;
  const close = code.closing(open);
  let j = close < 0 ? end : close + 1;
  while (j < end) {
    const c = m[j];
    if (c === ';') return { kind: 'skip', declEnd: open, memberEnd: j + 1 };
    if (c === '{') {
      const cl = code.closing(j);
      return { kind: 'skip', declEnd: open, memberEnd: cl < 0 ? end : cl + 1 };
    }
    if (c === '=' && m[j + 1] === '>') {
      const semi = firstAtDepth0(code, j, end, ';');
      return { kind: 'skip', declEnd: open, memberEnd: semi < 0 ? end : semi + 1 };
    }
    j++;
  }
  return { kind: 'skip', declEnd: open, memberEnd: end };
}

function propAccessor(code: Code, declStart: number, brace: number, end: number): MemberInfo {
  // Reject nested type bodies that slipped through (class/record keyword in the declarator).
  if (/\b(?:class|struct|record|interface|enum)\b/.test(code.slice(declStart, brace))) {
    const cl = code.closing(brace);
    return { kind: 'skip', declEnd: brace, memberEnd: cl < 0 ? end : cl + 1 };
  }
  const m = code.masked;
  const close = code.closing(brace);
  let j = close < 0 ? end : close + 1;
  while (j < end && isWs(m[j])) j++;
  if (m[j] === '=') {
    const semi = firstAtDepth0(code, j, end, ';');
    const init = code.slice(j + 1, semi < 0 ? end : semi).trim();
    return { kind: 'prop', declEnd: brace, memberEnd: semi < 0 ? end : semi + 1, initializer: init };
  }
  return { kind: 'prop', declEnd: brace, memberEnd: close < 0 ? end : close + 1 };
}

function exprMember(code: Code, declStart: number, arrow: number, end: number): MemberInfo {
  const semi = firstAtDepth0(code, arrow, end, ';');
  void declStart;
  return { kind: 'prop', declEnd: arrow, memberEnd: semi < 0 ? end : semi + 1 };
}

function fieldInit(code: Code, eq: number, end: number): MemberInfo {
  const semi = firstAtDepth0(code, eq, end, ';');
  const init = code.slice(eq + 1, semi < 0 ? end : semi).trim();
  return { kind: 'field', declEnd: eq, memberEnd: semi < 0 ? end : semi + 1, initializer: init };
}

function parseDeclarator(decl: string): { type: string; name: string } | undefined {
  const t = decl.trim().replace(/;+$/, '');
  if (!t) return undefined;
  const nm = /([A-Za-z_]\w*)\s*$/.exec(t);
  if (!nm) return undefined;
  const name = nm[1];
  const type = t.slice(0, nm.index).trim();
  if (!type) return undefined;
  return { type, name };
}

function isNavigation(def: Def, p: Prop): boolean {
  if (collectionElement(p.type)) return true;
  const simple = simpleName(p.type);
  if (CS_SCALARS.has(simple) || def.enumNames.has(simple)) return false;
  if (/\[\]$/.test(p.type.trim())) return false; // arrays of scalars (byte[])
  return true;
}

function buildScalar(def: Def, p: Prop): Column {
  const { code } = def;
  const colAttr = findAttr(p.attrs, 'Column');
  const name = attrString(code, colAttr) ?? p.name;
  const type = attrString(code, colAttr, 'TypeName') ?? csScalarType(p.type);
  const col = column(name, type, {
    nullable: csNullable(def, p),
    primaryKey: hasAttr(p.attrs, 'Key'),
    source: sourceRef(def.file, code.lineAt(p.memberStart)),
  });
  if (hasAttr(p.attrs, 'DatabaseGenerated')) col.generated = true;
  const comment = attrString(code, findAttr(p.attrs, 'Comment'));
  if (comment) col.comment = comment;
  if (def.enumNames.has(simpleName(p.type))) col.enumRef = simpleName(p.type);
  return col;
}

function csScalarType(type: string): string {
  return simpleName(type);
}

function csNullable(def: Def, p: Prop): boolean {
  if (hasAttr(p.attrs, 'Key')) return false;
  if (hasAttr(p.attrs, 'Required')) return false;
  const t = p.type.trim();
  if (t.endsWith('?')) return true;
  const simple = simpleName(t);
  if (CS_VALUE_TYPES.has(simple) || def.enumNames.has(simple)) return false;
  return !def_nrt(def);
}

let NRT_CACHE: WeakMap<Code, boolean> | undefined;
function def_nrt(def: Def): boolean {
  (NRT_CACHE ??= new WeakMap());
  let v = NRT_CACHE.get(def.code);
  if (v === undefined) {
    v = /#nullable\s+enable/.test(def.code.text) || /string\?/.test(def.code.text) || /\bobject\?/.test(def.code.text);
    NRT_CACHE.set(def.code, v);
  }
  return v;
}

function applyPkConvention(code: Code, t: CsType, scalars: Column[]): void {
  const pkAttr = findAttr(t.attributes, 'PrimaryKey');
  if (pkAttr) {
    for (const name of callProps(code, pkAttr.open)) {
      const col = scalars.find((c) => c.name === name);
      if (col) {
        col.primaryKey = true;
        col.nullable = false;
      }
    }
    return;
  }
  if (scalars.some((c) => c.primaryKey)) return;
  const pk = scalars.find((c) => c.name === 'Id') ?? scalars.find((c) => c.name.toLowerCase() === `${t.name}id`.toLowerCase());
  if (pk) {
    pk.primaryKey = true;
    pk.nullable = false;
  }
}

function classIndexes(def: Def, t: CsType): IndexDef[] {
  const { code } = def;
  const out: IndexDef[] = [];
  for (const attr of t.attributes) {
    if (attr.name !== 'Index' || attr.open < 0) continue;
    const cols = callProps(code, attr.open);
    if (!cols.length) continue;
    const unique = attrBool(code, attr, 'IsUnique') === true;
    const name = attrString(code, attr, 'Name');
    out.push({ columns: cols, unique, ...(name ? { name } : {}), source: sourceRef(def.file, code.lineAt(attr.open)) });
  }
  return out;
}

function emitNavigation(def: Def, t: CsType, nav: Prop, scalars: Column[]): void {
  const { code, file } = def;
  const src = sourceRef(file, code.lineAt(nav.memberStart));
  const element = collectionElement(nav.type);
  if (element) {
    def.result.relations.push({
      from: { model: t.name },
      fromColumns: [],
      to: { model: simpleName(element) },
      toColumns: [],
      cardinality: 'one-to-many',
      kind: 'orm',
      navigation: nav.name,
      source: src,
    });
    return;
  }
  const target = simpleName(nav.type);
  const fkAttr = findAttr(nav.attrs, 'ForeignKey');
  const fkFromAttr = fkAttr ? attrString(code, fkAttr) : undefined;
  const candidates = [fkFromAttr, `${nav.name}Id`, `${nav.name}${target}Id`, `${target}Id`].filter((x): x is string => !!x);
  let fkName = candidates.find((n) => scalars.some((c) => c.name === n)) ?? fkFromAttr ?? `${nav.name}Id`;
  const nullable = navNullable(def, nav, scalars, fkName);
  if (!scalars.some((c) => c.name === fkName)) {
    def.result.entities.find((e) => e.modelName === t.name)?.columns.push(column(fkName, '', { nullable }));
  }
  def.result.relations.push({
    from: { model: t.name },
    fromColumns: [fkName],
    to: { model: target },
    toColumns: [],
    cardinality: 'many-to-one',
    kind: 'orm',
    optional: nullable,
    navigation: nav.name,
    source: src,
  });
}

function navNullable(def: Def, nav: Prop, scalars: Column[], fkName: string): boolean {
  const fk = scalars.find((c) => c.name === fkName);
  if (fk) return fk.nullable && !fk.primaryKey;
  const t = nav.type.trim();
  if (t.endsWith('?')) return true;
  return !def_nrt(def);
}

// ── DbContext + IEntityTypeConfiguration ──

function parseDbContext(def: Def, t: CsType): void {
  const { code } = def;
  if (t.bodyOpen < 0 || t.bodyClose < 0) return;
  // DbSet<T> Name
  const m = code.masked;
  const re = /\bDbSet\s*<([^>]+)>\s+([A-Za-z_]\w*)/g;
  re.lastIndex = t.bodyOpen;
  let dm: RegExpExecArray | null;
  while ((dm = re.exec(m)) && dm.index < t.bodyClose) {
    const model = simpleName(dm[1]);
    const setName = dm[2];
    def.result.entities.push({
      name: setName,
      kind: 'table',
      modelName: model,
      nameCertainty: 1,
      columns: [],
      partial: true,
      source: sourceRef(def.file, code.lineAt(dm.index)),
    });
  }
  // OnModelCreating fluent configuration (modelBuilder.Entity<T>…)
  processModelBuilder(def, t.bodyOpen + 1, t.bodyClose, 'context');
}

function parseConfigClass(def: Def, t: CsType): void {
  const { code } = def;
  const generic = configModel(t);
  if (!generic || t.bodyOpen < 0 || t.bodyClose < 0) return;
  // Configure(EntityTypeBuilder<T> builder) { builder.… }
  const m = code.masked;
  const cm = /\bConfigure\s*\(/.exec(m.slice(t.bodyOpen, t.bodyClose));
  if (!cm) return;
  const parenOpen = t.bodyOpen + cm.index + cm[0].length - 1;
  const paramClose = code.closing(parenOpen);
  if (paramClose < 0) return;
  const builderVar = lastParamName(code, parenOpen, paramClose);
  const bodyOpen = code.masked.indexOf('{', paramClose);
  if (bodyOpen < 0 || bodyOpen >= t.bodyClose) return;
  const bodyClose = code.closing(bodyOpen);
  if (bodyClose < 0) return;
  const ctx = new EntityConfig(def, generic, 'context');
  for (const stmt of statements(code, bodyOpen + 1, bodyClose)) {
    if (startsWith(code, stmt.start, stmt.end, builderVar)) ctx.applyChain(chainCalls(code, stmt.start, stmt.end), stmt.start);
  }
  ctx.flush();
}

function configModel(t: CsType): string | undefined {
  return t.configGeneric;
}

function lastParamName(code: Code, open: number, close: number): string {
  const parts = code.split(open + 1, close, ',');
  const last = parts[parts.length - 1];
  if (!last) return 'builder';
  const nm = /([A-Za-z_]\w*)\s*$/.exec(last.text);
  return nm ? nm[1] : 'builder';
}

function processModelBuilder(def: Def, from: number, to: number, mode: FluentMode): void {
  const { code } = def;
  const m = code.masked;
  const re = /\.Entity\s*(?:<([^>]+)>)?\s*\(/g;
  re.lastIndex = from;
  let em: RegExpExecArray | null;
  while ((em = re.exec(m)) && em.index < to) {
    const open = em.index + em[0].length - 1;
    const close = code.closing(open);
    if (close < 0) break;
    const args = code.args(open);
    const model = em[1] ? simpleName(em[1]) : entityStringModel(args);
    if (!model) {
      re.lastIndex = close + 1;
      continue;
    }
    const cfg = new EntityConfig(def, model, mode);
    const lambda = args.positional.find((p) => topLevelArrow(p.text) >= 0);
    if (lambda) {
      const { builderVar, bodyStart, bodyEnd } = lambdaScope(code, lambda.start, lambda.end);
      for (const stmt of statements(code, bodyStart, bodyEnd)) {
        if (startsWith(code, stmt.start, stmt.end, builderVar)) cfg.applyChain(chainCalls(code, stmt.start, stmt.end), stmt.start);
      }
    } else {
      // chained: modelBuilder.Entity<T>().ToTable(…).HasKey(…)…;
      const stmtEnd = firstAtDepth0(code, close + 1, to, ';');
      cfg.applyChain(chainCalls(code, close + 1, stmtEnd < 0 ? to : stmtEnd), em.index);
    }
    cfg.flush();
    re.lastIndex = close + 1;
  }
}

function entityStringModel(args: { positional: { text: string }[] }): string | undefined {
  const first = args.positional[0];
  if (!first) return undefined;
  const s = stringValue(first.text);
  return s ? shortName(s) : undefined;
}

function lambdaScope(code: Code, from: number, to: number): { builderVar: string; bodyStart: number; bodyEnd: number } {
  const m = code.masked;
  const arrow = topLevelArrow(code.slice(from, to));
  const arrowAbs = from + arrow;
  const varText = code.slice(from, arrowAbs).replace(/[()]/g, '').trim();
  const builderVar = /([A-Za-z_]\w*)\s*$/.exec(varText)?.[1] ?? 'e';
  let i = arrowAbs + 2;
  while (i < to && isWs(m[i])) i++;
  if (m[i] === '{') {
    const close = code.closing(i);
    return { builderVar, bodyStart: i + 1, bodyEnd: close < 0 ? to : close };
  }
  return { builderVar, bodyStart: i, bodyEnd: to };
}

interface StmtRange {
  start: number;
  end: number;
}
function statements(code: Code, from: number, to: number): StmtRange[] {
  const m = code.masked;
  const out: StmtRange[] = [];
  let depth = 0;
  let seg = from;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push({ start: seg, end: i });
      seg = i + 1;
    }
  }
  if (seg < to) out.push({ start: seg, end: to });
  return out;
}

function startsWith(code: Code, from: number, to: number, varName: string): boolean {
  const m = code.masked;
  let i = from;
  while (i < to && isWs(m[i])) i++;
  return m.startsWith(varName, i) && !/[\w$]/.test(m[i + varName.length] ?? '');
}

type FluentMode = 'context' | 'snapshot';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fluent chain interpreter (shared by DbContext config and ModelSnapshot)
// ─────────────────────────────────────────────────────────────────────────────────────────────

class EntityConfig {
  private tableName?: string;
  private schema?: string;
  private certainty: 0 | 1 | 2;
  private readonly columns: Column[] = [];
  private readonly indexes: IndexDef[] = [];
  private readonly keyCols: string[] = [];
  private emitted = false;
  private firstLine = 0;
  private lineSet = false;

  constructor(
    private readonly def: Def,
    private readonly model: string,
    private readonly mode: FluentMode,
  ) {
    this.certainty = 0;
  }

  applyChain(calls: Call[], line: number): void {
    if (!this.lineSet) {
      this.firstLine = line;
      this.lineSet = true;
    }
    const { code } = this.def;
    let currentProp: string | undefined;
    let patch: ColumnPatch = {};
    let rename: string | undefined;
    let col: Column | undefined;
    const rel: RelAccum = {};
    const flushProp = () => {
      if (!currentProp) return;
      if (this.mode === 'context') {
        if (Object.keys(patch).length) this.op({ op: 'alterColumn', table: { model: this.model }, column: currentProp, set: patch, source: this.src(line) });
        if (rename && rename !== currentProp) this.op({ op: 'renameColumn', table: { model: this.model }, column: currentProp, to: rename, source: this.src(line) });
      } else if (col) {
        if (rename) col.name = rename;
        applyPatch(col, patch);
        this.columns.push(col);
      }
      currentProp = undefined;
      patch = {};
      rename = undefined;
      col = undefined;
    };

    for (const c of calls) {
      switch (c.name) {
        case 'OwnsOne':
        case 'OwnsMany': {
          // Owned value type, stored inside the owner's table. The target type is only known here
          // when given as a generic (`OwnsOne<Address>(…)`); otherwise the resolver maps the
          // navigation name through the owner's navigation property.
          const first = code.args(c.open).positional[0]?.text ?? '';
          const nav = propsFromArg(first)[0] ?? stringValue(first);
          const target = c.generic ? simpleName(c.generic) : nav;
          if (target) {
            this.def.result.relations.push({
              from: { model: this.model },
              fromColumns: [],
              to: { model: target },
              toColumns: [],
              cardinality: 'one-to-one',
              kind: 'orm',
              owned: true,
              ...(nav ? { name: nav } : {}),
              source: this.src(line),
            });
          }
          break;
        }
        case 'ToTable':
          this.tableName = stringPositional(code, c.open, 0) ?? this.tableName;
          this.schema = stringPositional(code, c.open, 1) ?? code.args(c.open).named.get('schema')?.text ?? this.schema;
          if (this.tableName) this.certainty = 2;
          break;
        case 'ToView':
          this.tableName = stringPositional(code, c.open, 0) ?? this.tableName;
          if (this.tableName) this.certainty = 2;
          break;
        case 'HasKey':
          for (const k of callProps(code, c.open)) if (!this.keyCols.includes(k)) this.keyCols.push(k);
          break;
        case 'Property': {
          flushProp();
          currentProp = callProps(code, c.open)[0];
          if (this.mode === 'snapshot' && currentProp) {
            col = column(currentProp, c.generic ? simpleName(c.generic) : '', { nullable: snapshotNullable(c.generic) });
          }
          break;
        }
        case 'HasColumnName':
          rename = stringPositional(code, c.open, 0) ?? rename;
          break;
        case 'HasColumnType':
          patch.type = stringPositional(code, c.open, 0) ?? patch.type;
          break;
        case 'IsRequired':
          patch.nullable = boolArg(code, c.open, 0) === false;
          break;
        case 'IsUnique':
          if (this.indexes.length) this.indexes[this.indexes.length - 1].unique = boolArg(code, c.open, 0) !== false;
          else if (rel.started) rel.oneToOne = true;
          break;
        case 'HasDefaultValueSql':
        case 'HasDefaultValue':
          patch.default = stringPositional(code, c.open, 0) ?? firstArgText(code, c.open);
          break;
        case 'ValueGeneratedOnAdd':
        case 'ValueGeneratedOnAddOrUpdate':
        case 'UseIdentityColumn':
        case 'UseIdentityByDefaultColumn':
        case 'UseSerialColumn':
          patch.generated = true;
          break;
        case 'ValueGeneratedNever':
          patch.generated = false;
          break;
        case 'HasMaxLength':
          break;
        case 'HasIndex': {
          const cols = callProps(code, c.open);
          if (cols.length) this.indexes.push({ columns: cols, unique: false, source: this.src(line) });
          break;
        }
        case 'HasOne':
          rel.started = true;
          rel.fromSide = 'one';
          rel.target = relTarget(code, c, this.mode, false);
          break;
        case 'HasMany':
          rel.started = true;
          rel.fromSide = 'many';
          rel.target = relTarget(code, c, this.mode, true);
          break;
        case 'WithOne':
          rel.otherSide = 'one';
          break;
        case 'WithMany':
          rel.otherSide = 'many';
          break;
        case 'HasForeignKey':
          rel.fkCols = callProps(code, c.open);
          rel.fkGeneric = c.generic ? simpleName(c.generic) : undefined;
          break;
        case 'HasPrincipalKey':
          rel.principalCols = callProps(code, c.open);
          break;
        case 'OnDelete':
          rel.onDelete = deleteBehavior(firstArgText(code, c.open));
          break;
        case 'HasConstraintName':
          rel.name = stringPositional(code, c.open, 0);
          break;
        case 'UsingEntity':
          rel.through = usingEntityName(code, c.open);
          break;
        default:
          break;
      }
    }
    flushProp();
    if (rel.started) this.emitRelation(rel, line);
  }

  private emitRelation(rel: RelAccum, line: number): void {
    const target = rel.target;
    if (!target) return;
    const self = this.model;
    let fromModel: string;
    let toModel: string;
    let cardinality: RawRelation['cardinality'];
    if (rel.fromSide === 'many' && rel.otherSide === 'many') {
      fromModel = self;
      toModel = target;
      cardinality = 'many-to-many';
    } else if (rel.fromSide === 'one') {
      // self HasOne(target); target WithMany(self) → FK on self.
      fromModel = self;
      toModel = target;
      cardinality = rel.otherSide === 'one' || rel.oneToOne ? 'one-to-one' : 'many-to-one';
    } else {
      // self HasMany(target); target WithOne(self) → FK on target.
      fromModel = target;
      toModel = self;
      cardinality = 'many-to-one';
    }
    const relation: RawRelation = {
      from: { model: fromModel },
      fromColumns: rel.fkCols ?? [],
      to: { model: toModel },
      toColumns: rel.principalCols ?? [],
      cardinality,
      kind: 'orm',
      source: this.src(line),
    };
    if (rel.onDelete) relation.onDelete = rel.onDelete;
    if (rel.name) relation.name = rel.name;
    if (cardinality === 'many-to-many' && rel.through) relation.through = { name: rel.through };
    this.def.result.relations.push(relation);
  }

  flush(): void {
    if (this.emitted) return;
    const hasContent = this.tableName || this.indexes.length || this.columns.length || this.keyCols.length || this.mode === 'snapshot';
    if (!hasContent) return;
    this.emitted = true;
    const line = this.firstLine;
    const name = this.tableName ?? this.model;
    const entity: RawEntity = {
      name,
      kind: 'table',
      modelName: this.model,
      nameCertainty: this.certainty,
      columns: this.columns,
      source: this.src(line),
    };
    if (this.schema) entity.schema = this.schema;
    if (this.mode === 'context') entity.partial = true;
    if (this.indexes.length) entity.indexes = [...this.indexes];
    for (const k of this.keyCols) {
      const col = this.columns.find((c) => c.name === k);
      if (col) {
        col.primaryKey = true;
        col.nullable = false;
      } else if (this.mode === 'context') {
        this.op({ op: 'alterColumn', table: { model: this.model }, column: k, set: { primaryKey: true }, source: this.src(line) });
      }
    }
    this.def.result.entities.push(entity);
  }

  private op(op: SchemaOp): void {
    (this.def.result.ops ??= []).push(op);
  }
  private src(line: number): SourceRef {
    return sourceRef(this.def.file, this.def.code.lineAt(line));
  }
}

interface RelAccum {
  started?: boolean;
  fromSide?: 'one' | 'many';
  otherSide?: 'one' | 'many';
  target?: string;
  fkCols?: string[];
  fkGeneric?: string;
  principalCols?: string[];
  onDelete?: string;
  name?: string;
  through?: string;
  oneToOne?: boolean;
}

function relTarget(code: Code, call: Call, mode: FluentMode, many: boolean): string | undefined {
  if (call.generic) return simpleName(call.generic);
  const pos = code.args(call.open).positional;
  if (!pos.length) return undefined;
  const str = stringValue(pos[0].text);
  if (str) return shortName(str); // snapshot string form "Ns.Type"
  const nav = propsFromArg(pos[0].text)[0];
  if (!nav) return undefined;
  void mode;
  return many ? singularize(nav) : nav;
}

function usingEntityName(code: Code, open: number): string | undefined {
  // UsingEntity(j => j.ToTable("PostTags")) or UsingEntity<Dictionary<…>>("PostTags")
  const inner = chainCalls(code, open + 1, code.closing(open) < 0 ? open + 1 : code.closing(open));
  for (const c of inner) if (c.name === 'ToTable') return stringPositional(code, c.open, 0);
  const pos = code.args(open).positional;
  for (const p of pos) {
    const s = stringValue(p.text);
    if (s) return s;
  }
  return undefined;
}

function stringPositional(code: Code, open: number, i: number): string | undefined {
  const pos = code.args(open).positional;
  return pos[i] ? stringValue(pos[i].text) : undefined;
}
function firstArgText(code: Code, open: number): string | undefined {
  const pos = code.args(open).positional;
  return pos.length ? pos[0].text.trim() : undefined;
}
function boolArg(code: Code, open: number, i: number): boolean | undefined {
  const pos = code.args(open).positional;
  return pos[i] ? boolValue(pos[i].text) : undefined;
}

function applyPatch(c: Column, set: ColumnPatch): void {
  for (const [k, v] of Object.entries(set)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
  if (set.primaryKey) c.nullable = false;
}

/** Initial nullability of a `b.Property<T>("x")` column in a ModelSnapshot (value types are NOT NULL). */
function snapshotNullable(generic: string | undefined): boolean {
  if (!generic) return true;
  if (generic.trim().endsWith('?')) return true;
  return !CS_VALUE_TYPES.has(simpleName(generic));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (d) ModelSnapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseSnapshot(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const def: Def = { code, file: file.path, result, enumNames: new Set() };
  const types = discoverCsTypes(code);
  const snapshot = types.find((t) => /ModelSnapshot$/.test(t.name) || t.baseNames.some((b) => b === 'ModelSnapshot'));
  const scope = snapshot && snapshot.bodyOpen >= 0 ? { from: snapshot.bodyOpen + 1, to: snapshot.bodyClose } : { from: 0, to: code.masked.length };
  collectEngineHints(code, file.path, result);
  processModelBuilder(def, scope.from, scope.to, 'snapshot');
  // Snapshot entities are non-candidate definitions already (EntityConfig emits them without candidate).
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (c) Migrations
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseMigration(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [] };
  const def: Def = { code, file: file.path, result, enumNames: new Set() };
  const up = findUpMethod(code);
  if (!up) return result;
  for (const call of builderCalls(code, up.from, up.to, 'migrationBuilder')) {
    dispatchMigrationCall(def, call);
  }
  return result;
}

function findUpMethod(code: Code): { from: number; to: number } | undefined {
  const m = code.masked;
  const mm = /\bvoid\s+Up\s*\(/.exec(m);
  if (!mm) return undefined;
  const paren = mm.index + mm[0].length - 1;
  const pc = code.closing(paren);
  if (pc < 0) return undefined;
  const brace = m.indexOf('{', pc);
  if (brace < 0) return undefined;
  const close = code.closing(brace);
  return { from: brace + 1, to: close < 0 ? m.length : close };
}

interface BuilderCall {
  name: string;
  generic?: string;
  open: number;
  line: number;
}

/** Finds `receiver.Method<…>(` statements in `[from, to)` (migration operations). */
function builderCalls(code: Code, from: number, to: number, receiver: string): BuilderCall[] {
  const m = code.masked;
  const out: BuilderCall[] = [];
  let i = from;
  const needle = receiver + '.';
  for (;;) {
    const at = m.indexOf(needle, i);
    if (at < 0 || at >= to) break;
    let j = at + needle.length;
    const nm = WORD_RE.exec(m.slice(j, j + 60));
    if (!nm) {
      i = j;
      continue;
    }
    j += nm[0].length;
    let generic: string | undefined;
    while (j < to && isWs(m[j])) j++;
    if (m[j] === '<') {
      const gc = code.closing(j);
      if (gc > 0) {
        generic = code.slice(j + 1, gc);
        j = gc + 1;
        while (j < to && isWs(m[j])) j++;
      }
    }
    if (m[j] === '(') {
      out.push({ name: nm[0], generic, open: j, line: code.lineAt(at) });
      const cl = code.closing(j);
      i = cl < 0 ? to : cl + 1;
      continue;
    }
    i = j;
  }
  return out;
}

function dispatchMigrationCall(def: Def, call: BuilderCall): void {
  switch (call.name) {
    case 'CreateTable':
      migCreateTable(def, call);
      break;
    case 'AddColumn':
      migAddColumn(def, call);
      break;
    case 'DropColumn':
      migOp(def, call, (t) => ({ op: 'dropColumn', table: { name: t.name! }, column: strNamed(def.code, call.open, 'name') ?? '', source: t.src }));
      break;
    case 'RenameColumn':
      migRenameColumn(def, call);
      break;
    case 'AlterColumn':
      migAlterColumn(def, call);
      break;
    case 'DropTable':
      migOp(def, call, (t) => ({ op: 'dropTable', table: { name: t.name! }, source: t.src }));
      break;
    case 'RenameTable':
      migRenameTable(def, call);
      break;
    case 'CreateIndex':
      migCreateIndex(def, call);
      break;
    case 'AddForeignKey':
      migAddForeignKey(def, call);
      break;
    case 'DropForeignKey':
      migOp(def, call, (t) => ({ op: 'dropForeignKey', table: { name: t.name! }, name: strNamed(def.code, call.open, 'name'), source: t.src }));
      break;
    case 'AddPrimaryKey':
      migAddPrimaryKey(def, call);
      break;
    default:
      break;
  }
}

function strNamed(code: Code, open: number, key: string): string | undefined {
  const span = code.args(open).named.get(key);
  return span ? stringValue(span.text) : undefined;
}

function boolNamed(code: Code, open: number, key: string): boolean | undefined {
  const span = code.args(open).named.get(key);
  return span ? boolValue(span.text) : undefined;
}

function tableCtx(def: Def, call: BuilderCall): { name?: string; src: SourceRef } {
  return { name: strNamed(def.code, call.open, 'name'), src: sourceRef(def.file, call.line) };
}

function migOp(def: Def, call: BuilderCall, make: (t: { name?: string; src: SourceRef }) => SchemaOp): void {
  const t = tableCtx(def, call);
  if (!t.name) return;
  (def.result.ops ??= []).push(make(t));
}

function migCreateTable(def: Def, call: BuilderCall): void {
  const { code } = def;
  const name = strNamed(code, call.open, 'name');
  if (!name) return;
  const schema = strNamed(code, call.open, 'schema');
  const src = sourceRef(def.file, call.line);
  const columns: Column[] = [];
  const colsSpan = code.args(call.open).named.get('columns');
  if (colsSpan) {
    const brace = code.masked.indexOf('{', colsSpan.start);
    if (brace >= 0 && brace < colsSpan.end) {
      const close = code.closing(brace);
      for (const part of code.split(brace + 1, close < 0 ? colsSpan.end : close, ',')) {
        const col = parseMigColumn(code, part.start, part.end);
        if (col) columns.push(col);
      }
    }
  }
  const entity: RawEntity = { name, kind: 'table', columns, source: src };
  if (schema) entity.schema = schema;
  def.result.entities.push(entity);

  const consSpan = code.args(call.open).named.get('constraints');
  if (consSpan) parseConstraints(def, name, schema, consSpan.start, consSpan.end, src);
}

function parseMigColumn(code: Code, from: number, to: number): Column | undefined {
  const eq = firstAtDepth0Str(code, from, to, '=');
  if (eq < 0) return undefined;
  const prop = code.slice(from, eq).trim();
  if (!/^[A-Za-z_]\w*$/.test(prop)) return undefined;
  const calls = [{ name: 'Column', open: colCallOpen(code, eq + 1, to) }].filter((c) => c.open >= 0);
  const open = calls.length ? calls[0].open : -1;
  if (open < 0) return undefined;
  const name = strNamed(code, open, 'name') ?? prop;
  const generic = genericOfCallAt(code, open);
  const type = strNamed(code, open, 'type') ?? (generic ? simpleName(generic) : '');
  const nullable = boolNamed(code, open, 'nullable');
  const col = column(name, type, { nullable: nullable !== false });
  if (nullable === false) col.nullable = false;
  const chainText = code.slice(eq + 1, to);
  if (/\.Annotation\s*\(\s*["'][^"']*(?:Identity|Autoincrement)/i.test(chainText)) col.generated = true;
  const defSql = /\.(?:defaultValueSql|defaultValue)\b/i.test(chainText);
  if (defSql) {
    const dv = strNamed(code, open, 'defaultValueSql') ?? strNamed(code, open, 'defaultValue');
    if (dv !== undefined) col.default = dv;
  }
  return col;
}

function colCallOpen(code: Code, from: number, to: number): number {
  // first `(` of `table.Column<T>(`
  const m = code.masked;
  for (let i = from; i < to; i++) if (m[i] === '(') return i;
  return -1;
}

function genericOfCallAt(code: Code, open: number): string | undefined {
  // read `<…>` immediately before `open`
  const m = code.masked;
  let j = open - 1;
  while (j > 0 && isWs(m[j])) j--;
  if (m[j] !== '>') return undefined;
  // find matching '<' backwards
  let depth = 0;
  for (let i = j; i >= 0; i--) {
    if (m[i] === '>') depth++;
    else if (m[i] === '<' && --depth === 0) return code.slice(i + 1, j);
  }
  return undefined;
}

function parseConstraints(def: Def, table: string, schema: string | undefined, from: number, to: number, src: SourceRef): void {
  const { code } = def;
  for (const call of builderCalls(code, from, to, 'table')) {
    if (call.name === 'PrimaryKey') {
      for (const colName of pkColsFromCall(code, call.open)) {
        (def.result.ops ??= []).push({ op: 'alterColumn', table: refOf(table, schema), column: colName, set: { primaryKey: true }, source: src });
      }
    } else if (call.name === 'ForeignKey') {
      const cols = colsNamed(code, call.open, 'column', 'columns');
      const principalTable = strNamed(code, call.open, 'principalTable');
      const principalCols = colsNamed(code, call.open, 'principalColumn', 'principalColumns');
      const name = strNamed(code, call.open, 'name');
      const onDelete = deleteBehavior(code.args(call.open).named.get('onDelete')?.text);
      if (principalTable && cols.length) {
        const rel: RawRelation = {
          from: refOf(table, schema),
          fromColumns: cols,
          to: { name: principalTable },
          toColumns: principalCols,
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          source: src,
        };
        if (onDelete) rel.onDelete = onDelete;
        if (name) rel.name = name;
        def.result.relations.push(rel);
      }
    } else if (call.name === 'UniqueConstraint') {
      const cols = colsNamed(code, call.open, 'column', 'columns');
      const name = strNamed(code, call.open, 'name');
      if (cols.length) {
        const ent = def.result.entities.find((e) => e.name === table);
        const ix: IndexDef = { columns: cols, unique: true, ...(name ? { name } : {}), source: src };
        if (ent) (ent.indexes ??= []).push(ix);
      }
    }
  }
}

function pkColsFromCall(code: Code, open: number): string[] {
  // table.PrimaryKey("PK_x", x => x.Col | x => new {x.A, x.B})
  const pos = code.args(open).positional;
  const out: string[] = [];
  for (let i = 1; i < pos.length; i++) out.push(...propsFromArg(pos[i].text));
  if (!out.length && pos.length) out.push(...propsFromArg(pos[0].text).filter((p) => !/^PK_/i.test(p)));
  return out;
}

function colsNamed(code: Code, open: number, single: string, plural: string): string[] {
  const args = code.args(open);
  const s = args.named.get(single);
  if (s) return propsFromArg(s.text);
  const p = args.named.get(plural);
  if (p) return propsFromArg(p.text);
  return [];
}

function refOf(name: string, schema?: string): { name: string; schema?: string } {
  return schema ? { name, schema } : { name };
}

function migAddColumn(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  const name = strNamed(code, call.open, 'name');
  if (!table || !name) return;
  const type = strNamed(code, call.open, 'type') ?? (call.generic ? simpleName(call.generic) : '');
  const nullable = boolNamed(code, call.open, 'nullable');
  const schema = strNamed(code, call.open, 'schema');
  const col = column(name, type, { nullable: nullable !== false });
  const entity: RawEntity = { name: table, kind: 'table', columns: [col], partial: true, source: sourceRef(def.file, call.line) };
  if (schema) entity.schema = schema;
  def.result.entities.push(entity);
}

function migRenameColumn(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  const name = strNamed(code, call.open, 'name');
  const to = strNamed(code, call.open, 'newName');
  if (!table || !name || !to) return;
  (def.result.ops ??= []).push({ op: 'renameColumn', table: { name: table }, column: name, to, source: sourceRef(def.file, call.line) });
}

function migAlterColumn(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  const name = strNamed(code, call.open, 'name');
  if (!table || !name) return;
  const set: ColumnPatch = {};
  const type = strNamed(code, call.open, 'type') ?? (call.generic ? simpleName(call.generic) : undefined);
  if (type) set.type = type;
  const nullable = boolNamed(code, call.open, 'nullable');
  if (nullable !== undefined) set.nullable = nullable;
  const defVal = strNamed(code, call.open, 'defaultValueSql') ?? strNamed(code, call.open, 'defaultValue');
  if (defVal !== undefined) set.default = defVal;
  (def.result.ops ??= []).push({ op: 'alterColumn', table: { name: table }, column: name, set, source: sourceRef(def.file, call.line) });
}

function migRenameTable(def: Def, call: BuilderCall): void {
  const { code } = def;
  const name = strNamed(code, call.open, 'name');
  const to = strNamed(code, call.open, 'newName');
  if (!name || !to) return;
  (def.result.ops ??= []).push({ op: 'renameTable', table: { name }, to, source: sourceRef(def.file, call.line) });
}

function migCreateIndex(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  if (!table) return;
  const cols = colsNamed(code, call.open, 'column', 'columns');
  if (!cols.length) return;
  const name = strNamed(code, call.open, 'name');
  const unique = boolNamed(code, call.open, 'unique') === true;
  const entity: RawEntity = {
    name: table,
    kind: 'table',
    columns: [],
    partial: true,
    indexes: [{ columns: cols, unique, ...(name ? { name } : {}), source: sourceRef(def.file, call.line) }],
    source: sourceRef(def.file, call.line),
  };
  const schema = strNamed(code, call.open, 'schema');
  if (schema) entity.schema = schema;
  def.result.entities.push(entity);
}

function migAddForeignKey(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  const principalTable = strNamed(code, call.open, 'principalTable');
  const cols = colsNamed(code, call.open, 'column', 'columns');
  if (!table || !principalTable || !cols.length) return;
  const principalCols = colsNamed(code, call.open, 'principalColumn', 'principalColumns');
  const name = strNamed(code, call.open, 'name');
  const onDelete = deleteBehavior(code.args(call.open).named.get('onDelete')?.text);
  const rel: RawRelation = {
    from: { name: table },
    fromColumns: cols,
    to: { name: principalTable },
    toColumns: principalCols,
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    source: sourceRef(def.file, call.line),
  };
  if (onDelete) rel.onDelete = onDelete;
  if (name) rel.name = name;
  def.result.relations.push(rel);
}

function migAddPrimaryKey(def: Def, call: BuilderCall): void {
  const { code } = def;
  const table = strNamed(code, call.open, 'table');
  if (!table) return;
  const cols = colsNamed(code, call.open, 'column', 'columns');
  for (const c of cols) {
    (def.result.ops ??= []).push({ op: 'alterColumn', table: { name: table }, column: c, set: { primaryKey: true }, source: sourceRef(def.file, call.line) });
  }
}

function firstAtDepth0Str(code: Code, from: number, to: number, ch: string): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (depth === 0 && c === ch && m[i + 1] !== '=' && m[i - 1] !== '=') return i;
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth = Math.max(0, depth - 1);
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engines
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ENGINE_CALLS: Readonly<Record<string, { engine: EngineHint['engine']; detail: string }>> = {
  UseNpgsql: { engine: 'postgresql', detail: 'EF Core UseNpgsql' },
  UseSqlServer: { engine: 'sqlserver', detail: 'EF Core UseSqlServer' },
  UseSqlite: { engine: 'sqlite', detail: 'EF Core UseSqlite' },
  UseMySql: { engine: 'mysql', detail: 'EF Core UseMySql' },
  UseMySQL: { engine: 'mysql', detail: 'EF Core UseMySQL' },
  UseOracle: { engine: 'oracle', detail: 'EF Core UseOracle' },
  UseCosmos: { engine: 'cosmosdb', detail: 'EF Core UseCosmos' },
  UseMongoDB: { engine: 'mongodb', detail: 'EF Core UseMongoDB' },
};

function collectEngineHints(code: Code, _file: string, result: ParseResult): void {
  const m = code.masked;
  for (const name of Object.keys(ENGINE_CALLS)) {
    const re = new RegExp('\\b' + name + '\\s*(?:<[^>]*>)?\\s*\\(', 'g');
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(m))) {
      const info = ENGINE_CALLS[name];
      (result.engines ??= []).push({ engine: info.engine, line: code.lineAt(mt.index), detail: info.detail });
      break; // one hint per engine kind is enough
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Detect + export
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/\bDbContext\b/.test(t) || /\bDbSet\s*</.test(t)) return true;
  if (/\bmigrationBuilder\b/.test(t) && /:\s*Migration\b/.test(t)) return true;
  if (/\bmodelBuilder\.Entity\b/.test(t)) return true;
  if (/\bIEntityTypeConfiguration\s*</.test(t)) return true;
  if (/using\s+Microsoft\.EntityFrameworkCore\b/.test(t) && /\[(?:Table|Key|Column)\b/.test(t)) return true;
  // Plain POCO entity classes (no EF imports) are emitted as candidates; the resolver keeps only
  // those confirmed by a DbSet<T> / fluent configuration or reached through navigations.
  if (/\bclass\s+[A-Za-z_]\w*/.test(t) && /\{\s*get\s*;\s*(?:set|init|private\s+set|protected\s+set)\s*;/.test(t)) return true;
  return false;
}

export const efcoreParser: SchemaParser = {
  kind: 'efcore',
  extensions: ['.cs'],
  detect,
  parse,
};
