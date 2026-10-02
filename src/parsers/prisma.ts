/**
 * Prisma schema parser (`.prisma`).
 *
 * Handles `datasource` (engine hint), `model` / `view` blocks, `enum` blocks, composite `type`
 * blocks (MongoDB embedded documents – not entities), field attributes (`@id`, `@unique`,
 * `@default`, `@map`, `@db.*`, `@updatedAt`, `@relation`, `@ignore`), block attributes (`@@map`,
 * `@@schema`, `@@id`, `@@unique`, `@@index`, `@@ignore`), relations (explicit `@relation` and
 * implicit many-to-many), MongoDB collections and `///` doc comments.
 */

import type { Column, EngineHint, EngineId, ParseResult, RawEntity, RawEnum, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { cleanComment, Code, type Span, stringValue } from '../core/text';

const PRISMA_SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

const PROVIDER_ENGINE: Readonly<Record<string, EngineId>> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  sqlserver: 'sqlserver',
  mongodb: 'mongodb',
  cockroachdb: 'cockroachdb',
};

const BLOCK = /\b(datasource|generator|model|view|enum|type)\s+([A-Za-z_]\w*)\s*\{/g;

interface Block {
  keyword: string;
  name: string;
  open: number;
  close: number;
  line: number;
}

interface FieldAttr {
  name: string;
  open: number;
  close: number;
}

interface FieldLine {
  name: string;
  baseType: string;
  isList: boolean;
  isOptional: boolean;
  attrs: FieldAttr[];
  start: number;
  line: number;
}

interface ParsedModel {
  block: Block;
  kind: 'table' | 'view' | 'collection';
  fields: FieldLine[];
  /** field name → real column name (scalar fields only). */
  columnOf: Map<string, string>;
  tableName: string;
  schema?: string;
  nameCertainty: 0 | 2;
  ignore: boolean;
  idFields: string[];
  uniques: { columns: string[]; name?: string }[];
  indexes: string[][];
  comment?: string;
}

export const prismaParser: SchemaParser = {
  kind: 'prisma',
  extensions: ['.prisma'],
  detect(file: SourceFile): boolean {
    return /(^|\n)\s*(datasource|generator|model|enum|view|type)\s+[A-Za-z_]/.test(file.text);
  },
  parse,
};

function parse(file: SourceFile): ParseResult {
  const result = emptyResult('definition');
  const text = file.text;
  if (!text) return result;
  const code = new Code(text, 'prisma');

  const blocks = findBlocks(code);
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  const typeNames = new Set<string>();
  for (const b of blocks) {
    if (b.keyword === 'model' || b.keyword === 'view') modelNames.add(b.name);
    else if (b.keyword === 'enum') enumNames.add(b.name);
    else if (b.keyword === 'type') typeNames.add(b.name);
  }

  // datasource provider → engine hint; detect MongoDB.
  let mongo = false;
  let providerEngine: EngineId | undefined;
  for (const b of blocks) {
    if (b.keyword !== 'datasource') continue;
    const provider = readAssignment(code, b, 'provider');
    const engine = provider ? PROVIDER_ENGINE[provider.toLowerCase()] : undefined;
    if (engine) {
      pushEngine(result, { engine, line: b.line, detail: `datasource provider "${provider}"` });
      providerEngine ??= engine;
      if (engine === 'mongodb') mongo = true;
    }
  }

  // enums
  const enumMappedName = new Map<string, string>();
  for (const b of blocks) {
    if (b.keyword !== 'enum') continue;
    const en = parseEnum(code, b, file);
    if (en) {
      enumMappedName.set(b.name, en.name);
      result.enums.push(en);
    }
  }

  // models / views
  const models: ParsedModel[] = [];
  for (const b of blocks) {
    if (b.keyword !== 'model' && b.keyword !== 'view') continue;
    const pm = parseModel(code, b, mongo);
    if (!pm.ignore) models.push(pm);
  }

  for (const pm of models) {
    emitEntity(result, file, pm, modelNames, enumNames, typeNames, enumMappedName, code, providerEngine);
  }
  emitRelations(result, file, code, models, modelNames, typeNames);

  return result;
}

function findBlocks(code: Code): Block[] {
  const out: Block[] = [];
  BLOCK.lastIndex = 0;
  let mt: RegExpExecArray | null;
  while ((mt = BLOCK.exec(code.masked))) {
    const open = mt.index + mt[0].length - 1;
    const close = code.closing(open);
    if (close < 0) continue;
    out.push({ keyword: mt[1], name: mt[2], open, close, line: code.lineAt(mt.index) });
    BLOCK.lastIndex = open + 1;
  }
  return out;
}

/** `key = "value"` inside a block (datasource / generator). */
function readAssignment(code: Code, b: Block, key: string): string | undefined {
  const body = code.stripped.slice(b.open + 1, b.close);
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(.+)`).exec(body);
  return m ? stringValue(m[1].trim()) : undefined;
}

function parseEnum(code: Code, b: Block, file: SourceFile): RawEnum | undefined {
  let name = b.name;
  let schema: string | undefined;
  const values: string[] = [];
  for (const seg of blockLines(code, b)) {
    const trimmed = code.stripped.slice(seg.start, seg.end).trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@@')) {
      const at = scanAttrs(code, seg.start, seg.end);
      for (const a of at) {
        if (a.name === 'map') name = firstString(code, a) ?? name;
        else if (a.name === 'schema') schema = firstString(code, a) ?? schema;
      }
      continue;
    }
    const vm = /^([A-Za-z_]\w*)/.exec(trimmed);
    if (!vm) continue;
    const attrs = scanAttrs(code, seg.start, seg.end);
    const mapped = attrs.find((a) => a.name === 'map');
    values.push((mapped && firstString(code, mapped)) || vm[1]);
  }
  if (!values.length) return undefined;
  return { name, values, ...(schema ? { schema } : {}), source: sourceRef(file, b.line) };
}

function parseModel(code: Code, b: Block, mongo: boolean): ParsedModel {
  const fields: FieldLine[] = [];
  const columnOf = new Map<string, string>();
  let tableName = b.name;
  let nameCertainty: 0 | 2 = 0;
  let schema: string | undefined;
  let ignore = false;
  const idFields: string[] = [];
  const uniques: { columns: string[]; name?: string }[] = [];
  const indexes: string[][] = [];

  for (const seg of blockLines(code, b)) {
    const trimmed = code.stripped.slice(seg.start, seg.end).trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@@')) {
      for (const a of scanAttrs(code, seg.start, seg.end)) {
        if (a.name === 'map') {
          tableName = firstString(code, a) ?? tableName;
          nameCertainty = 2;
        } else if (a.name === 'schema') schema = firstString(code, a) ?? schema;
        else if (a.name === 'ignore') ignore = true;
        else if (a.name === 'id') idFields.push(...listArg(code, a));
        else if (a.name === 'unique') uniques.push({ columns: listArg(code, a), name: namedString(code, a, 'map') });
        else if (a.name === 'index') indexes.push(listArg(code, a));
      }
      continue;
    }
    const field = parseFieldLine(code, seg);
    if (field) fields.push(field);
  }

  // build scalar column-name map (apply @map)
  for (const f of fields) {
    const mapAttr = f.attrs.find((a) => a.name === 'map');
    columnOf.set(f.name, (mapAttr && firstString(code, mapAttr)) || f.name);
  }

  // MongoDB detection: datasource mongodb, or an id field mapped to `_id` + @db.ObjectId.
  let kind: ParsedModel['kind'] = b.keyword === 'view' ? 'view' : mongo ? 'collection' : 'table';
  if (kind !== 'collection' && b.keyword === 'model') {
    const mongoId = fields.some(
      (f) =>
        f.attrs.some((a) => a.name === 'id') &&
        (columnOf.get(f.name) === '_id' || f.attrs.some((a) => a.name === 'db.ObjectId')),
    );
    if (mongoId) kind = 'collection';
  }

  const comment = docComment(code, b.open);
  return { block: b, kind, fields, columnOf, tableName, schema, nameCertainty, ignore, idFields, uniques, indexes, comment };
}

function parseFieldLine(code: Code, seg: { start: number; end: number }): FieldLine | undefined {
  const stripped = code.stripped;
  // first identifier (field name)
  let i = seg.start;
  while (i < seg.end && /\s/.test(stripped[i])) i++;
  const nameM = /^[A-Za-z_]\w*/.exec(stripped.slice(i, seg.end));
  if (!nameM) return undefined;
  const name = nameM[0];
  let j = i + name.length;
  while (j < seg.end && /\s/.test(stripped[j])) j++;
  // type: identifier (+ optional `("…")` for Unsupported) + `[]` + `?`
  const typeM = /^([A-Za-z_]\w*(?:\("[^"]*"\))?)(\[\])?(\?)?/.exec(stripped.slice(j, seg.end));
  if (!typeM) return undefined;
  const baseType = typeM[1];
  const isList = !!typeM[2];
  const isOptional = !!typeM[3];
  const attrsStart = j + typeM[0].length;
  const attrs = scanAttrs(code, attrsStart, seg.end);
  return { name, baseType, isList, isOptional, attrs, start: i, line: code.lineAt(i) };
}

/** `@attr` / `@attr(...)` / `@db.Native(...)` tokens inside `[start, end)`, searched on masked. */
function scanAttrs(code: Code, start: number, end: number): FieldAttr[] {
  const m = code.masked;
  const out: FieldAttr[] = [];
  const re = /@@?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/g;
  re.lastIndex = start;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m)) && mt.index < end) {
    let p = mt.index + mt[0].length;
    let open = -1;
    let close = -1;
    if (m[p] === '(') {
      open = p;
      close = code.closing(p);
      p = close < 0 ? end : close + 1;
    }
    out.push({ name: mt[1], open, close });
    re.lastIndex = Math.max(p, mt.index + 1);
  }
  return out;
}

function firstString(code: Code, a: FieldAttr): string | undefined {
  if (a.open < 0) return undefined;
  const args = code.args(a.open);
  const sp = args.positional[0] ?? args.named.get('name');
  return sp ? stringValue(sp.text) : undefined;
}

function namedString(code: Code, a: FieldAttr, key: string): string | undefined {
  if (a.open < 0) return undefined;
  const sp = code.args(a.open).named.get(key);
  return sp ? stringValue(sp.text) : undefined;
}

/** Field names listed in `@@id([a, b])` / `@relation(fields: [a])`. */
function listArg(code: Code, a: FieldAttr): string[] {
  if (a.open < 0) return [];
  const first = code.args(a.open).positional[0];
  if (!first || first.text[0] !== '[') return [];
  return code.items(first.start).map((s) => s.text.trim()).filter(Boolean);
}

function namedList(code: Code, a: FieldAttr, key: string): string[] {
  if (a.open < 0) return [];
  const sp = code.args(a.open).named.get(key);
  if (!sp || sp.text[0] !== '[') return [];
  return code.items(sp.start).map((s) => s.text.trim()).filter(Boolean);
}

/** True when a field carries an attribute only scalar / enum fields can have (never relation fields). */
function hasScalarAttr(f: FieldLine): boolean {
  return f.attrs.some(
    (a) =>
      a.name === 'default' ||
      a.name === 'updatedAt' ||
      a.name === 'id' ||
      a.name === 'unique' ||
      a.name === 'map' ||
      a.name.startsWith('db.'),
  );
}

function emitEntity(
  result: ParseResult,
  file: SourceFile,
  pm: ParsedModel,
  modelNames: Set<string>,
  enumNames: Set<string>,
  typeNames: Set<string>,
  enumMappedName: Map<string, string>,
  code: Code,
  providerEngine: EngineId | undefined,
): void {
  const columns: Column[] = [];
  for (const f of pm.fields) {
    if (f.attrs.some((a) => a.name === 'ignore')) continue;
    const base = f.baseType;
    const isScalar = PRISMA_SCALARS.has(base) || base.startsWith('Unsupported');
    const isEnum = enumNames.has(base);
    const isComposite = typeNames.has(base);
    const isRelation = f.attrs.some((a) => a.name === 'relation');
    if (!isScalar && !isEnum && !isComposite && (modelNames.has(base) || isRelation || (!isScalar && f.isList && !isEnum))) {
      continue; // relation field (handled by emitRelations)
    }
    // Multi-file schemas (`prisma/schema/*.prisma`): a field whose type is not a scalar and not
    // defined in THIS file is a relation to a model declared in another file. An optional singular
    // field (`profile Profile?`) with no scalar attributes is the non-owning side of a 1:1 / 1:n
    // relation, not a column — the owning side (with `@relation(fields:…)`) lives in the other file.
    if (
      !isScalar &&
      !isEnum &&
      !isComposite &&
      !modelNames.has(base) &&
      f.isOptional &&
      !f.isList &&
      !hasScalarAttr(f)
    ) {
      continue; // relation back-reference whose model is defined in another schema file
    }
    columns.push(buildColumn(code, file, pm, f, isEnum, enumMappedName));
  }

  // composite / @@id / @@unique → flags on columns
  const colByField = (fieldName: string) => columns.find((c) => c.name === (pm.columnOf.get(fieldName) ?? fieldName));
  if (pm.idFields.length) {
    for (const fn of pm.idFields) {
      const c = colByField(fn);
      if (c) {
        c.primaryKey = true;
        c.nullable = false;
      }
    }
  }

  const indexes = [
    ...pm.uniques.map((u) => ({ columns: mapCols(pm, u.columns), unique: true, ...(u.name ? { name: u.name } : {}) })),
    ...pm.indexes.map((cols) => ({ columns: mapCols(pm, cols), unique: false })),
  ].filter((ix) => ix.columns.length > 0);

  const entity: RawEntity = {
    name: pm.tableName,
    kind: pm.kind,
    modelName: pm.block.name,
    nameCertainty: pm.nameCertainty,
    columns,
    source: sourceRef(file, pm.block.line),
  };
  if (pm.schema) entity.schema = pm.schema;
  if (providerEngine) entity.engine = providerEngine;
  if (indexes.length) entity.indexes = indexes;
  if (pm.comment) entity.comment = pm.comment;
  result.entities.push(entity);
}

function mapCols(pm: ParsedModel, fields: string[]): string[] {
  return fields.map((f) => pm.columnOf.get(f) ?? f).filter(Boolean);
}

function buildColumn(code: Code, file: SourceFile, pm: ParsedModel, f: FieldLine, isEnum: boolean, enumMappedName: Map<string, string>): Column {
  const name = pm.columnOf.get(f.name) ?? f.name;
  let type = f.baseType;
  const props: Partial<Column> = { source: sourceRef(file, f.line) };

  let nullable = f.isOptional;
  for (const a of f.attrs) {
    switch (a.name) {
      case 'id':
        props.primaryKey = true;
        nullable = false;
        break;
      case 'unique':
        props.unique = true;
        break;
      case 'updatedAt':
        props.generated = true;
        break;
      case 'default':
        applyDefault(code, a, props);
        break;
      default:
        if (a.name.startsWith('db.')) {
          type = nativeType(code, a);
        }
    }
  }
  if (f.isList) {
    props.isArray = true;
    nullable = false;
  }
  props.nullable = nullable;
  if (isEnum) props.enumRef = enumMappedName.get(f.baseType) ?? f.baseType;
  return column(name, type, props);
}

function nativeType(code: Code, a: FieldAttr): string {
  const native = a.name.slice(3); // strip `db.`
  if (a.open < 0) return native;
  const inner = code.slice(a.open + 1, a.close < 0 ? a.open + 1 : a.close).trim();
  return inner ? `${native}(${inner})` : native;
}

function applyDefault(code: Code, a: FieldAttr, props: Partial<Column>): void {
  if (a.open < 0) return;
  const expr = code.slice(a.open + 1, a.close < 0 ? a.open + 1 : a.close).trim();
  if (!expr) return;
  if (/^(autoincrement|uuid|cuid|auto|sequence|nanoid)\s*\(/.test(expr)) {
    props.generated = true;
    return;
  }
  if (/^now\s*\(/.test(expr)) {
    props.generated = true;
    props.default = 'now()';
    return;
  }
  if (/^dbgenerated\s*\(/.test(expr)) {
    props.generated = true;
    const val = stringValue(expr.replace(/^dbgenerated\s*\(/, '').replace(/\)$/, '').trim());
    if (val) props.default = val;
    return;
  }
  props.default = stringValue(expr) ?? expr;
}

function emitRelations(
  result: ParseResult,
  file: SourceFile,
  code: Code,
  models: ParsedModel[],
  modelNames: Set<string>,
  typeNames: Set<string>,
): void {
  const byModel = new Map<string, ParsedModel>();
  for (const pm of models) byModel.set(pm.block.name, pm);

  interface NavList {
    model: string;
    target: string;
    relationName?: string;
  }
  const navLists: NavList[] = [];

  for (const pm of models) {
    for (const f of pm.fields) {
      if (f.attrs.some((a) => a.name === 'ignore')) continue;
      const base = f.baseType;
      if (PRISMA_SCALARS.has(base) || typeNames.has(base) || base.startsWith('Unsupported')) continue;
      const relAttr = f.attrs.find((a) => a.name === 'relation');
      const fieldsList = relAttr ? namedList(code, relAttr, 'fields') : [];
      const refsList = relAttr ? namedList(code, relAttr, 'references') : [];
      const relationName = relAttr ? relationNameOf(code, relAttr) : undefined;
      const target = base;
      const isModelRef = modelNames.has(target) || !!relAttr || f.isList;
      if (!isModelRef) continue;

      if (fieldsList.length) {
        // owning side – many-to-one (one-to-one when the FK is unique)
        const fromColumns = fieldsList.map((fn) => pm.columnOf.get(fn) ?? fn);
        const targetModel = byModel.get(target);
        const toColumns = refsList.map((rn) => targetModel?.columnOf.get(rn) ?? rn);
        const unique = isUniqueFk(pm, fieldsList);
        const rel: RawRelation = {
          from: { model: pm.block.name, name: pm.tableName, ...(pm.schema ? { schema: pm.schema } : {}) },
          fromColumns,
          to: { model: target, ...(targetModel ? { name: targetModel.tableName } : {}) },
          toColumns,
          cardinality: unique ? 'one-to-one' : 'many-to-one',
          kind: 'orm',
          source: sourceRef(file, f.line),
        };
        if (relationName) rel.name = relationName;
        const onDelete = namedBare(code, relAttr!, 'onDelete');
        const onUpdate = namedBare(code, relAttr!, 'onUpdate');
        if (onDelete) rel.onDelete = onDelete;
        if (onUpdate) rel.onUpdate = onUpdate;
        if (f.isOptional) rel.optional = true;
        result.relations.push(rel);
      } else if (f.isList) {
        // list without `fields:` → back-relation of 1-n or one side of implicit m2m
        navLists.push({ model: pm.block.name, target, relationName });
      }
      // optional singular back-relations without `fields:` are skipped
    }
  }

  emitImplicitM2M(result, file, models, byModel, navLists);
}

function emitImplicitM2M(
  result: ParseResult,
  file: SourceFile,
  _models: ParsedModel[],
  byModel: Map<string, ParsedModel>,
  navLists: { model: string; target: string; relationName?: string }[],
): void {
  const done = new Set<string>();
  for (let a = 0; a < navLists.length; a++) {
    const f = navLists[a];
    // find a matching back-list on the other side with the same relation name
    const partnerIndex = navLists.findIndex(
      (g, idx) => idx !== a && g.model === f.target && g.target === f.model && (g.relationName ?? '') === (f.relationName ?? ''),
    );
    if (partnerIndex < 0) continue;
    const [m1, m2] = [f.model, f.target].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const pairKey = `${m1}|${m2}|${f.relationName ?? ''}`;
    if (done.has(pairKey)) continue;
    done.add(pairKey);
    const through = f.relationName ? `_${f.relationName}` : `_${m1}To${m2}`;
    const pmA = byModel.get(m1);
    const pmB = byModel.get(m2);
    result.relations.push({
      from: { model: m1, ...(pmA ? { name: pmA.tableName } : {}) },
      fromColumns: [],
      to: { model: m2, ...(pmB ? { name: pmB.tableName } : {}) },
      toColumns: [],
      cardinality: 'many-to-many',
      kind: 'orm',
      through: { name: through },
      ...(f.relationName ? { name: f.relationName } : {}),
      source: sourceRef(file, pmA?.block.line ?? 0),
    });
  }
}

function relationNameOf(code: Code, a: FieldAttr): string | undefined {
  if (a.open < 0) return undefined;
  const args = code.args(a.open);
  const pos = args.positional[0];
  if (pos) {
    const v = stringValue(pos.text);
    if (v !== undefined) return v;
  }
  const named = args.named.get('name');
  return named ? stringValue(named.text) : undefined;
}

function namedBare(code: Code, a: FieldAttr, key: string): string | undefined {
  if (!a || a.open < 0) return undefined;
  const sp = code.args(a.open).named.get(key);
  return sp ? sp.text.trim() : undefined;
}

function isUniqueFk(pm: ParsedModel, fields: string[]): boolean {
  if (fields.length === 1) {
    const f = pm.fields.find((x) => x.name === fields[0]);
    if (f?.attrs.some((a) => a.name === 'unique')) return true;
  }
  const cols = fields.map((f) => pm.columnOf.get(f) ?? f).map((c) => c.toLowerCase()).sort();
  return pm.uniques.some((u) => {
    const uc = u.columns.map((f) => (pm.columnOf.get(f) ?? f).toLowerCase()).sort();
    return uc.length === cols.length && uc.every((c, i) => c === cols[i]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Line segments of a block body, as `[start, end)` offset ranges. */
function blockLines(code: Code, b: Block): Span[] {
  const out: Span[] = [];
  const startLine = code.lineAt(b.open);
  const endLine = code.lineAt(b.close);
  for (let ln = startLine; ln <= endLine; ln++) {
    const s = Math.max(b.open + 1, code.lineStart(ln));
    const e = Math.min(b.close, code.lineEnd(ln));
    if (s < e) out.push({ start: s, end: e, text: '' });
  }
  return out;
}

/** Joined `///` doc comments directly above `offset`. */
function docComment(code: Code, offset: number): string | undefined {
  const docs = code.leadingComments(offset).filter((c) => /^\s*\/\/\//.test(c));
  if (!docs.length) return undefined;
  const text = cleanComment(docs.join('\n'));
  return text || undefined;
}

function pushEngine(result: ParseResult, hint: EngineHint): void {
  (result.engines ??= []).push(hint);
}
