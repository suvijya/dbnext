/**
 * Rails parser: ActiveRecord db/schema.rb, db/migrate migrations and app/models model classes
 * (plus basic Mongoid document support).
 *
 *  - schema.rb (ActiveRecord::Schema[..].define) → definitions
 *  - migrations (ActiveRecord::Migration, `def change` / `def up`, `down` ignored) → migration history
 *  - models (class X < ApplicationRecord) → definitions (associations, table name, enums, STI)
 */

import type {
  Column,
  ColumnPatch,
  EntityKind,
  EntityRef,
  IndexDef,
  ParseResult,
  RawEntity,
  RawRelation,
  SchemaOp,
  SourceFile,
  SourceRef,
} from '../core/model';
import { column, pathSegments, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName, pascalCase, pluralize, shortName, singularize, snakeCase } from '../core/naming';
import { type Args, Code, boolValue, stringValue } from '../core/text';
import { addColumn, callArgs, inlineEnumName, listValues, splitArgs } from './shared/rubyphp';

function detect(file: SourceFile): boolean {
  const t = file.text;
  // schema.rb and migrations
  if (/ActiveRecord::(?:Schema|Migration)\b/.test(t)) return true;
  // ActiveRecord models (incl. `ApplicationRecord < ActiveRecord::Base` itself)
  if (/<\s*(?:::)?(?:ApplicationRecord|ActiveRecord::Base)\b/.test(t)) return true;
  if (/include\s+Mongoid::Document/.test(t)) return true;
  const segs = pathSegments(file.path);
  if (segs.includes('migrate')) return true;
  // STI children / models living in app/models that only inherit from another model: require
  // both a `class X < Something` header and at least one ActiveRecord DSL marker. A stray
  // `rescue ActiveRecord::RecordNotFound` in a controller or service must NOT make it a model file.
  return (
    segs.includes('models') &&
    /\bclass\s+[\w:]+\s*<\s*[A-Z]/.test(t) &&
    /\b(belongs_to|has_many|has_one|has_and_belongs_to_many|self\.table_name|validates|scope|enum)\b/.test(t)
  );
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'ruby');
  const m = code.masked;
  if (/ActiveRecord::Schema/.test(m)) return parseSchema(file, code);
  if (/ActiveRecord::Migration/.test(m) || pathSegments(file.path).includes('migrate')) return parseMigration(file, code);
  return parseModels(file, code);
}

// ── shared bits ─────────────────────────────────────────────────────────────────────────────

const TABLE_TYPES =
  /^(string|text|integer|bigint|float|decimal|numeric|boolean|date|datetime|timestamp|time|binary|blob|json|jsonb|uuid|inet|cidr|macaddr|hstore|citext|money|interval|daterange|int4range|int8range|tsrange|tstzrange|numrange|point|line|geometry|virtual|bit)$/;

/** `do` keyword offset that opens a block after `from` (schema / migration `… do |t|`). */
function blockDo(code: Code, from: number): number {
  const m = code.masked;
  for (const mm of m.slice(from).matchAll(/\bdo\b/g)) {
    const at = from + mm.index!;
    if (code.isCode(at)) return at;
  }
  return -1;
}

/** Reads a `create_table "x", opts do |t|` header; returns the table name, options and block. */
function tableHeader(code: Code, kwEnd: number): { name?: string; args: Args; blockStart: number; blockEnd: number; line: number } {
  const doAt = blockDo(code, kwEnd);
  const argEnd = doAt >= 0 ? doAt : Math.min(code.statementEnd(kwEnd), code.text.length);
  const args = callArgs(code, kwEnd, argEnd);
  const line = code.lineAt(kwEnd);
  const block = doAt >= 0 ? code.indentedBlock(code.lineAt(doAt)) : { start: argEnd, end: argEnd };
  return { name: stringValue(args.positional[0]?.text), args, blockStart: block.start, blockEnd: block.end, line };
}

interface TCtx {
  table: string;
  file: string;
  cols: Column[];
  indexes: IndexDef[];
  relations: RawRelation[];
}

/** Parses the `t.xxx` lines inside a `create_table` block. */
function collectTableBody(code: Code, start: number, end: number, ctx: TCtx): void {
  for (const mm of code.masked.slice(start, end).matchAll(/^([ \t]*)t\.(\w+)\b/gm)) {
    const kw = mm[2];
    const at = start + mm.index! + mm[1].length;
    const afterName = start + mm.index! + mm[0].length;
    if (!code.isCode(at)) continue;
    const args = callArgs(code, afterName, end);
    const ref = sourceRef(ctx.file, code.lineAt(at));
    tableColumn(kw, args, ctx, ref);
  }
}

function tableColumn(kw: string, args: Args, ctx: TCtx, ref: SourceRef): void {
  const name = stringValue(args.positional[0]?.text);
  if (kw === 'timestamps') {
    addColumn(ctx.cols, column('created_at', 'datetime', { nullable: false, source: ref }));
    addColumn(ctx.cols, column('updated_at', 'datetime', { nullable: false, source: ref }));
    return;
  }
  if (kw === 'index') {
    if (name !== undefined || args.positional[0]) addIndexFrom(args, ctx, ref);
    return;
  }
  if (kw === 'references' || kw === 'belongs_to') {
    tableReference(args, ctx, ref);
    return;
  }
  if (!name) return;
  if (kw === 'enum') {
    const enumType = stringValue(args.named.get('enum_type')?.text) ?? inlineEnumName(ctx.table, name);
    addColumn(ctx.cols, column(name, enumType, { nullable: nullableOf(args), enumRef: enumType, source: ref }));
    return;
  }
  if (kw === 'column' || kw === 'primary_key') {
    const type = kw === 'primary_key' ? (stringValue(args.positional[1]?.text) ?? 'bigint') : (stringValue(args.positional[1]?.text) ?? '');
    const props: Partial<Column> = { nullable: nullableOf(args), source: ref, ...columnProps(args) };
    if (kw === 'primary_key') {
      props.primaryKey = true;
      props.nullable = false;
      props.generated = true;
    }
    addColumn(ctx.cols, column(name, type, props));
    return;
  }
  if (TABLE_TYPES.test(kw)) {
    addColumn(ctx.cols, column(name, kw, { nullable: nullableOf(args), source: ref, ...columnProps(args) }));
  }
}

function columnProps(args: Args): Partial<Column> {
  const props: Partial<Column> = {};
  const def = args.named.get('default');
  if (def) props.default = stringValue(def.text) ?? def.text;
  const comment = stringValue(args.named.get('comment')?.text);
  if (comment !== undefined) props.comment = comment;
  if (boolValue(args.named.get('array')?.text) === true) props.isArray = true;
  return props;
}

function nullableOf(args: Args): boolean {
  return boolValue(args.named.get('null')?.text) === false ? false : true;
}

function tableReference(args: Args, ctx: TCtx, ref: SourceRef): void {
  const name = stringValue(args.positional[0]?.text);
  if (!name) return;
  const type = stringValue(args.named.get('type')?.text) ?? 'bigint';
  const nullable = nullableOf(args);
  const poly = boolValue(args.named.get('polymorphic')?.text) === true;
  addColumn(ctx.cols, column(`${name}_id`, type, { nullable, source: ref }));
  if (poly) {
    addColumn(ctx.cols, column(`${name}_type`, 'string', { nullable, source: ref }));
    return;
  }
  const fkOpt = args.named.get('foreign_key')?.text;
  if (fkOpt === undefined) return;
  if (boolValue(fkOpt) === false) return;
  const toTable = hashOpt(fkOpt, 'to_table') ?? pluralize(name);
  ctx.relations.push({
    from: { name: ctx.table },
    fromColumns: [`${name}_id`],
    to: { name: toTable },
    toColumns: [],
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    optional: nullable,
    source: ref,
  });
}

function addIndexFrom(args: Args, ctx: TCtx, ref: SourceRef): void {
  const colsExpr = args.positional[0]?.text;
  if (!colsExpr) return;
  const columns = /^\[/.test(colsExpr.trim()) ? listValues(colsExpr) : ([stringValue(colsExpr)].filter(Boolean) as string[]);
  if (!columns.length) return;
  const unique = boolValue(args.named.get('unique')?.text) === true;
  const name = stringValue(args.named.get('name')?.text);
  ctx.indexes.push({ columns, unique, ...(name ? { name } : {}), source: ref });
}

/** Reads `key: value` out of a hash literal text such as `{ to_table: :accounts }`. */
function hashOpt(text: string | undefined, key: string): string | undefined {
  if (!text) return undefined;
  const m = new RegExp(`${key}\\s*:\\s*(:?["']?[\\w./]+["']?)`).exec(text);
  return m ? stringValue(m[1]) : undefined;
}

function railsAction(sym: string | undefined): string | undefined {
  const v = stringValue(sym);
  if (!v) return undefined;
  const map: Record<string, string> = { cascade: 'CASCADE', nullify: 'SET NULL', restrict: 'RESTRICT' };
  return map[v] ?? v.toUpperCase();
}

function pgEngine(code: Code, into: ParseResult): void {
  const m = /\b(enable_extension|create_enum)\b/.exec(code.masked);
  if (m && code.isCode(m.index)) {
    (into.engines ??= []).push({ engine: 'postgresql', line: code.lineAt(m.index), detail: 'Rails PostgreSQL schema' });
  }
}

// ── schema.rb ───────────────────────────────────────────────────────────────────────────────

function parseSchema(file: SourceFile, code: Code): ParseResult {
  const m = code.masked;
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };

  for (const cm of m.matchAll(/^[ \t]*create_table\b/gm)) {
    const kwEnd = cm.index! + cm[0].length;
    if (!code.isCode(cm.index! + (cm[0].length - 'create_table'.length))) continue;
    const h = tableHeader(code, kwEnd);
    if (!h.name) continue;
    const entity = buildCreateTable(h, file);
    result.entities.push(entity);
    const ctx: TCtx = { table: h.name, file: file.path, cols: entity.columns, indexes: entity.indexes!, relations: result.relations };
    collectTableBody(code, h.blockStart, h.blockEnd, ctx);
  }

  for (const em of m.matchAll(/^[ \t]*create_enum\b/gm)) {
    const kwEnd = em.index! + em[0].length;
    const args = callArgs(code, kwEnd, Math.min(code.statementEnd(kwEnd), code.text.length));
    const name = stringValue(args.positional[0]?.text);
    const values = listValues(args.positional[1]?.text ?? '');
    if (name && values.length) {
      const schema = stringValue(args.named.get('schema')?.text);
      result.enums.push({ name, values, ...(schema ? { schema } : {}), source: sourceRef(file, code.lineAt(em.index!)) });
    }
  }

  for (const fm of m.matchAll(/^[ \t]*add_foreign_key\b/gm)) {
    addForeignKey(code, fm.index! + fm[0].length, file, result.relations);
  }

  for (const im of m.matchAll(/^[ \t]*add_index\b/gm)) {
    addIndexStatement(code, im.index! + im[0].length, file, result.entities);
  }

  pgEngine(code, result);
  return result;
}

function buildCreateTable(h: ReturnType<typeof tableHeader>, file: SourceFile): RawEntity {
  const cols: Column[] = [];
  const idOpt = h.args.named.get('id')?.text;
  const pkName = stringValue(h.args.named.get('primary_key')?.text) ?? 'id';
  if (boolValue(idOpt) !== false) {
    const pkType = idOpt ? (stringValue(idOpt) ?? 'bigint') : 'bigint';
    cols.push(column(pkName, pkType, { primaryKey: true, nullable: false, generated: true }));
  }
  const comment = stringValue(h.args.named.get('comment')?.text);
  const entity: RawEntity = {
    name: h.name!,
    kind: 'table',
    nameCertainty: 2,
    columns: cols,
    indexes: [],
    source: sourceRef(file, h.line),
  };
  if (comment !== undefined) entity.comment = comment;
  return entity;
}

function addForeignKey(code: Code, kwEnd: number, file: SourceFile, relations: RawRelation[]): void {
  const args = callArgs(code, kwEnd, Math.min(code.statementEnd(kwEnd), code.text.length));
  const from = stringValue(args.positional[0]?.text);
  const to = stringValue(args.positional[1]?.text);
  if (!from || !to) return;
  const col = stringValue(args.named.get('column')?.text) ?? `${singularize(to)}_id`;
  const pk = stringValue(args.named.get('primary_key')?.text);
  const onDelete = railsAction(args.named.get('on_delete')?.text);
  const onUpdate = railsAction(args.named.get('on_update')?.text);
  const name = stringValue(args.named.get('name')?.text);
  relations.push({
    from: { name: from },
    fromColumns: [col],
    to: { name: to },
    toColumns: pk ? [pk] : [],
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    ...(name ? { name } : {}),
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    source: sourceRef(file, code.lineAt(kwEnd)),
  });
}

function addIndexStatement(code: Code, kwEnd: number, file: SourceFile, entities: RawEntity[]): void {
  const args = callArgs(code, kwEnd, Math.min(code.statementEnd(kwEnd), code.text.length));
  const table = stringValue(args.positional[0]?.text);
  const colsExpr = args.positional[1]?.text;
  if (!table || !colsExpr) return;
  const columns = /^\[/.test(colsExpr.trim()) ? listValues(colsExpr) : ([stringValue(colsExpr)].filter(Boolean) as string[]);
  if (!columns.length) return;
  const unique = boolValue(args.named.get('unique')?.text) === true;
  const name = stringValue(args.named.get('name')?.text);
  entities.push({
    name: table,
    kind: 'table',
    partial: true,
    columns: [],
    indexes: [{ columns, unique, ...(name ? { name } : {}), source: sourceRef(file, code.lineAt(kwEnd)) }],
    source: sourceRef(file, code.lineAt(kwEnd)),
  });
}

// ── migrations ──────────────────────────────────────────────────────────────────────────────

interface Range {
  start: number;
  end: number;
}

const MIG_KEYWORDS =
  /^[ \t]*(create_table|create_join_table|change_table|add_column|remove_column|rename_column|change_column_null|change_column_default|change_column|add_reference|add_belongs_to|remove_reference|add_foreign_key|remove_foreign_key|drop_table|rename_table|add_index|remove_index|create_enum|add_timestamps)\b/gm;

function parseMigration(file: SourceFile, code: Code): ParseResult {
  const m = code.masked;
  const result: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [], ops: [] };

  const active: Range[] = [];
  for (const dm of m.matchAll(/\bdef\s+(?:change|up)\b/g)) {
    const b = code.indentedBlock(code.lineAt(dm.index!));
    active.push({ start: b.start, end: b.end });
  }
  if (!active.length) active.push({ start: 0, end: code.text.length });
  const excludes: Range[] = [];
  for (const dd of m.matchAll(/\bdir\.down\b/g)) {
    const b = code.indentedBlock(code.lineAt(dd.index!));
    excludes.push({ start: b.start, end: b.end });
  }
  const inActive = (at: number) =>
    active.some((r) => at >= r.start && at < r.end) && !excludes.some((r) => at >= r.start && at < r.end);

  for (const mm of m.matchAll(MIG_KEYWORDS)) {
    const kw = mm[1];
    const at = mm.index! + (mm[0].length - kw.length);
    if (!inActive(at) || !code.isCode(at)) continue;
    const kwEnd = mm.index! + mm[0].length;
    migrationStatement(code, kw, at, kwEnd, file, result);
  }

  return result;
}

function migrationStatement(code: Code, kw: string, at: number, kwEnd: number, file: SourceFile, result: ParseResult): void {
  const ops = result.ops!;
  const ref = sourceRef(file, code.lineAt(at));

  if (kw === 'create_table') {
    const h = tableHeader(code, kwEnd);
    if (!h.name) return;
    const entity = buildCreateTable(h, file);
    result.entities.push(entity);
    collectTableBody(code, h.blockStart, h.blockEnd, {
      table: h.name,
      file: file.path,
      cols: entity.columns,
      indexes: entity.indexes!,
      relations: result.relations,
    });
    return;
  }
  if (kw === 'create_join_table') {
    createJoinTable(code, kwEnd, file, result.entities);
    return;
  }
  if (kw === 'change_table') {
    const h = tableHeader(code, kwEnd);
    if (!h.name) return;
    changeTableBody(code, h.blockStart, h.blockEnd, h.name, file, result);
    return;
  }

  const args = callArgs(code, kwEnd, Math.min(code.statementEnd(kwEnd), code.text.length));
  const table = stringValue(args.positional[0]?.text);
  if (!table) return;

  switch (kw) {
    case 'add_column': {
      const colName = stringValue(args.positional[1]?.text);
      const type = stringValue(args.positional[2]?.text) ?? '';
      if (colName) {
        result.entities.push({
          name: table,
          kind: 'table',
          partial: true,
          columns: [column(colName, type, { nullable: nullableOf(args), source: ref, ...columnProps(args) })],
          source: ref,
        });
      }
      return;
    }
    case 'remove_column':
    case 'remove_reference': {
      if (kw === 'remove_reference') {
        const base = stringValue(args.positional[1]?.text);
        if (base) ops.push({ op: 'dropColumn', table: { name: table }, column: `${base}_id`, source: ref });
        return;
      }
      for (let i = 1; i < args.positional.length; i++) {
        const c = stringValue(args.positional[i].text);
        if (c) ops.push({ op: 'dropColumn', table: { name: table }, column: c, source: ref });
      }
      return;
    }
    case 'rename_column': {
      const from = stringValue(args.positional[1]?.text);
      const to = stringValue(args.positional[2]?.text);
      if (from && to) ops.push({ op: 'renameColumn', table: { name: table }, column: from, to, source: ref });
      return;
    }
    case 'change_column': {
      const col = stringValue(args.positional[1]?.text);
      const type = stringValue(args.positional[2]?.text);
      if (col) {
        const set: ColumnPatch = {};
        if (type) set.type = type;
        if (args.named.has('null')) set.nullable = boolValue(args.named.get('null')!.text) !== false;
        const def = args.named.get('default');
        if (def) set.default = stringValue(def.text) ?? def.text;
        ops.push({ op: 'alterColumn', table: { name: table }, column: col, set, source: ref });
      }
      return;
    }
    case 'change_column_null': {
      const col = stringValue(args.positional[1]?.text);
      const v = boolValue(args.positional[2]?.text);
      if (col) ops.push({ op: 'alterColumn', table: { name: table }, column: col, set: { nullable: v !== false }, source: ref });
      return;
    }
    case 'change_column_default': {
      const col = stringValue(args.positional[1]?.text);
      const to = args.named.get('to')?.text ?? args.positional[2]?.text;
      if (col && to !== undefined) ops.push({ op: 'alterColumn', table: { name: table }, column: col, set: { default: stringValue(to) ?? to }, source: ref });
      return;
    }
    case 'add_reference':
    case 'add_belongs_to': {
      addReference(args, table, ref, result);
      return;
    }
    case 'add_foreign_key':
      addForeignKey(code, kwEnd, file, result.relations);
      return;
    case 'remove_foreign_key': {
      removeForeignKey(args, table, ref, ops);
      return;
    }
    case 'drop_table':
      ops.push({ op: 'dropTable', table: { name: table }, source: ref });
      return;
    case 'rename_table': {
      const to = stringValue(args.positional[1]?.text);
      if (to) ops.push({ op: 'renameTable', table: { name: table }, to, source: ref });
      return;
    }
    case 'add_index': {
      addIndexStatement(code, kwEnd, file, result.entities);
      return;
    }
    case 'add_timestamps': {
      result.entities.push({
        name: table,
        kind: 'table',
        partial: true,
        columns: [column('created_at', 'datetime', { nullable: false, source: ref }), column('updated_at', 'datetime', { nullable: false, source: ref })],
        source: ref,
      });
      return;
    }
    case 'create_enum': {
      const values = listValues(args.positional[1]?.text ?? '');
      if (values.length) result.enums.push({ name: table, values, source: ref });
      return;
    }
    default:
      return;
  }
}

function addReference(args: Args, table: string, ref: SourceRef, result: ParseResult): void {
  const base = stringValue(args.positional[1]?.text);
  if (!base) return;
  const type = stringValue(args.named.get('type')?.text) ?? 'bigint';
  const nullable = nullableOf(args);
  const poly = boolValue(args.named.get('polymorphic')?.text) === true;
  const cols: Column[] = [column(`${base}_id`, type, { nullable, source: ref })];
  if (poly) cols.push(column(`${base}_type`, 'string', { nullable, source: ref }));
  result.entities.push({ name: table, kind: 'table', partial: true, columns: cols, source: ref });
  const fkOpt = args.named.get('foreign_key')?.text;
  if (!poly && fkOpt !== undefined && boolValue(fkOpt) !== false) {
    const toTable = hashOpt(fkOpt, 'to_table') ?? pluralize(base);
    result.relations.push({
      from: { name: table },
      fromColumns: [`${base}_id`],
      to: { name: toTable },
      toColumns: [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      optional: nullable,
      source: ref,
    });
  }
}

function removeForeignKey(args: Args, table: string, ref: SourceRef, ops: SchemaOp[]): void {
  const name = stringValue(args.named.get('name')?.text);
  const col = stringValue(args.named.get('column')?.text);
  const to = stringValue(args.positional[1]?.text);
  const op: Extract<SchemaOp, { op: 'dropForeignKey' }> = { op: 'dropForeignKey', table: { name: table }, source: ref };
  if (name) op.name = name;
  else if (col) op.columns = [col];
  else if (to) op.to = { name: to };
  ops.push(op);
}

function createJoinTable(code: Code, kwEnd: number, file: SourceFile, entities: RawEntity[]): void {
  const h = tableHeader(code, kwEnd);
  const a = stringValue(h.args.positional[0]?.text);
  const b = stringValue(h.args.positional[1]?.text);
  if (!a || !b) return;
  const tableOpt = stringValue(h.args.named.get('table_name')?.text);
  const name = tableOpt ?? [a, b].slice().sort().join('_');
  const ref = sourceRef(file, h.line);
  entities.push({
    name,
    kind: 'table',
    nameCertainty: 2,
    columns: [
      column(`${singularize(a)}_id`, 'bigint', { nullable: false, source: ref }),
      column(`${singularize(b)}_id`, 'bigint', { nullable: false, source: ref }),
    ],
    indexes: [],
    source: ref,
  });
}

function changeTableBody(code: Code, start: number, end: number, table: string, file: SourceFile, result: ParseResult): void {
  const ops = result.ops!;
  const added: Column[] = [];
  for (const mm of code.masked.slice(start, end).matchAll(/^([ \t]*)t\.(\w+)\b/gm)) {
    const kw = mm[2];
    const at = start + mm.index! + mm[1].length;
    const afterName = start + mm.index! + mm[0].length;
    if (!code.isCode(at)) continue;
    const args = callArgs(code, afterName, end);
    const ref = sourceRef(file, code.lineAt(at));
    if (kw === 'remove') {
      for (const p of args.positional) {
        const c = stringValue(p.text);
        if (c) ops.push({ op: 'dropColumn', table: { name: table }, column: c, source: ref });
      }
    } else if (kw === 'rename') {
      const from = stringValue(args.positional[0]?.text);
      const to = stringValue(args.positional[1]?.text);
      if (from && to) ops.push({ op: 'renameColumn', table: { name: table }, column: from, to, source: ref });
    } else {
      const ctx: TCtx = { table, file: file.path, cols: added, indexes: [], relations: result.relations };
      tableColumn(kw, args, ctx, ref);
    }
  }
  if (added.length) result.entities.push({ name: table, kind: 'table', partial: true, columns: added, source: sourceRef(file, code.lineAt(start)) });
}

// ── models ──────────────────────────────────────────────────────────────────────────────────

const ASSOC = /^[ \t]*(belongs_to|has_many|has_one|has_and_belongs_to_many|embeds_one|embeds_many|field|enum)\b/gm;

/** `ApplicationRecord`, `ActiveRecord::Base` (optionally `::`-prefixed): the roots of the model tree. */
function isRootBase(rawBase: string): boolean {
  return /^(?:::)?(?:ApplicationRecord|ActiveRecord::Base)$/.test(rawBase.trim());
}

/** ActiveRecord DSL that a plain Ruby class / ActiveModel object / service never uses. */
const AR_MARKERS = /\b(?:belongs_to|has_many|has_one|has_and_belongs_to_many|enum)\b|self\.table_name/;

interface ModelDecl {
  rawName: string;
  className: string;
  rawBase: string;
  baseShort: string;
  classAt: number;
  classLine: number;
  block: { start: number; end: number };
  body: string;
  bodyMasked: string;
  isMongoid: boolean;
}

function parseModels(file: SourceFile, code: Code): ParseResult {
  const m = code.masked;
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const inModelsDir = pathSegments(file.path).includes('models');

  // Pass 1: collect every `class X < Base` declaration.
  const decls: ModelDecl[] = [];
  for (const cm of m.matchAll(/^([ \t]*)class\s+([\w:]+)\s*<\s*([\w:]+)/gm)) {
    const classAt = cm.index! + cm[1].length;
    if (!code.isCode(classAt)) continue; // a `class X < Y` seen inside a heredoc / string is not code
    const classLine = code.lineAt(classAt);
    const block = code.indentedBlock(classLine);
    const bodyMasked = m.slice(block.start, block.end);
    const isMongoid = /include\s+Mongoid::Document/.test(bodyMasked) || /include\s+Mongoid::Document/.test(m.slice(0, classAt));
    decls.push({
      rawName: cm[2],
      className: shortName(cm[2]),
      rawBase: cm[3],
      baseShort: shortName(cm[3]),
      classAt,
      classLine,
      block: { start: block.start, end: block.end },
      body: code.stripped.slice(block.start, block.end),
      bodyMasked,
      isMongoid,
    });
  }

  // Pass 2: a class is a model when it reaches ApplicationRecord / ActiveRecord::Base (directly or
  // through a base defined in the same file), is a Mongoid document, or lives in app/models and uses
  // ActiveRecord DSL (cross-file STI children). This keeps controllers, services, workers, serializers,
  // form objects, error classes etc. – which merely mention ActiveRecord – from becoming phantom tables.
  const byName = new Map<string, ModelDecl>();
  for (const d of decls) if (!byName.has(d.className)) byName.set(d.className, d);
  const memo = new Map<ModelDecl, boolean>();
  const isModel = (d: ModelDecl, stack = new Set<ModelDecl>()): boolean => {
    const cached = memo.get(d);
    if (cached !== undefined) return cached;
    if (stack.has(d)) return false;
    stack.add(d);
    let r = false;
    if (isRootBase(d.rawBase) || d.isMongoid) r = true;
    else {
      const parent = byName.get(d.baseShort);
      if (parent && parent !== d && isModel(parent, stack)) r = true;
      else if (inModelsDir && AR_MARKERS.test(d.bodyMasked)) r = true;
    }
    memo.set(d, r);
    return r;
  };

  // Pass 3: emit the models.
  for (const d of decls) {
    if (!isModel(d)) continue;
    const kind: EntityKind = d.isMongoid ? 'collection' : 'table';
    const isRoot = isRootBase(d.rawBase);
    const abstract = /self\.abstract_class\s*=\s*true/.test(d.body) || /\bprimary_abstract_class\b/.test(d.bodyMasked);

    const tableNameMatch = /self\.table_name\s*=\s*(['"])([^'"]+)\1/.exec(d.body);
    const table = tableNameMatch ? tableNameMatch[2] : defaultTableName('rails', d.className);

    const entity: RawEntity = {
      name: table,
      kind,
      modelName: d.className,
      nameCertainty: tableNameMatch ? 2 : 0,
      columns: [],
      source: sourceRef(file, d.classLine),
    };
    if (abstract) entity.abstract = true;
    else if (!isRoot) {
      entity.extends = [d.baseShort];
      entity.sharedTable = true;
    }
    if (d.isMongoid) entity.columns.push(column('_id', 'ObjectId', { primaryKey: true, nullable: false, generated: true }));
    result.entities.push(entity);

    collectModelBody(code, d.block.start, d.block.end, table, d.className, file, entity, result);
  }

  return result;
}

function collectModelBody(
  code: Code,
  start: number,
  end: number,
  table: string,
  model: string,
  file: SourceFile,
  entity: RawEntity,
  result: ParseResult,
): void {
  for (const mm of code.masked.slice(start, end).matchAll(ASSOC)) {
    const kw = mm[1];
    const kwOffset = start + mm.index! + (mm[0].length - kw.length);
    const afterName = start + mm.index! + mm[0].length;
    if (!code.isCode(kwOffset)) continue;
    const args = callArgs(code, afterName, end);
    const ref = sourceRef(file, code.lineAt(kwOffset));
    const self: EntityRef = { name: table, model };

    if (kw === 'field') {
      // Mongoid field :name, type: String
      const n = stringValue(args.positional[0]?.text);
      if (n) addColumn(entity.columns, column(n, stringValue(args.named.get('type')?.text) ?? '', { source: ref }));
      continue;
    }
    if (kw === 'enum') {
      modelEnum(args, table, ref, result);
      continue;
    }
    const assoc = stringValue(args.positional[0]?.text);
    if (!assoc) continue;
    if (boolValue(args.named.get('polymorphic')?.text) === true) continue; // polymorphic belongs_to
    if (args.named.has('through')) continue; // has_many :through – skip
    const target = stringValue(args.named.get('class_name')?.text) ?? pascalCase(singularize(assoc));

    if (kw === 'belongs_to') {
      const fk = stringValue(args.named.get('foreign_key')?.text) ?? `${assoc}_id`;
      const optional = boolValue(args.named.get('optional')?.text) === true;
      result.relations.push({
        from: self,
        fromColumns: [fk],
        to: { model: target },
        toColumns: [],
        cardinality: 'many-to-one',
        kind: 'orm',
        optional,
        source: ref,
      });
    } else if (kw === 'has_many' || kw === 'embeds_many') {
      if (kw === 'embeds_many') continue;
      const fk = stringValue(args.named.get('foreign_key')?.text) ?? `${snakeCase(model)}_id`;
      result.relations.push({ from: self, fromColumns: [], to: { model: target }, toColumns: [fk], cardinality: 'one-to-many', kind: 'orm', source: ref });
    } else if (kw === 'has_one' || kw === 'embeds_one') {
      if (kw === 'embeds_one') continue;
      const fk = stringValue(args.named.get('foreign_key')?.text) ?? `${snakeCase(model)}_id`;
      result.relations.push({ from: { model: target }, fromColumns: [fk], to: self, toColumns: [], cardinality: 'one-to-one', kind: 'orm', source: ref });
    } else if (kw === 'has_and_belongs_to_many') {
      const targetTable = defaultTableName('rails', target);
      const join = stringValue(args.named.get('join_table')?.text) ?? [table, targetTable].slice().sort().join('_');
      result.relations.push({ from: self, fromColumns: [], to: { model: target }, toColumns: [], cardinality: 'many-to-many', kind: 'orm', through: { name: join }, source: ref });
    }
  }
}

function modelEnum(args: Args, table: string, ref: SourceRef, result: ParseResult): void {
  // enum status: { active: 0, archived: 1 }  |  enum :status, { active: 0 }  |  enum :status, [:active]
  const emit = (attr: string, valuesExpr: string) => {
    const values = enumKeys(valuesExpr);
    if (values.length) result.enums.push({ name: inlineEnumName(table, attr), values, source: ref });
  };
  if (args.named.size) {
    for (const [attr, span] of args.named) emit(attr, span.text);
  } else {
    const attr = stringValue(args.positional[0]?.text);
    const valuesExpr = args.positional[1]?.text;
    if (attr && valuesExpr) emit(attr, valuesExpr);
  }
}

/** Keys of a `{ active: 0, archived: 1 }` hash or values of a `[:active, :archived]` list. */
function enumKeys(text: string): string[] {
  const t = text.trim();
  if (t.startsWith('[')) return listValues(t);
  const inner = t.replace(/^\{/, '').replace(/\}$/, '');
  const out: string[] = [];
  for (const part of splitArgs(inner)) {
    const m = /^(?::?([A-Za-z_]\w*)|["']([^"']+)["'])\s*(?::|=>)/.exec(part.trim());
    if (m) out.push(m[1] ?? m[2]);
  }
  return out;
}

export const railsParser: SchemaParser = {
  kind: 'rails',
  extensions: ['.rb'],
  detect,
  parse,
};
