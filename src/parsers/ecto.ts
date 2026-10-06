/**
 * Ecto (Elixir) parser.
 *
 * Reads two kinds of files:
 *  - schema modules (`use Ecto.Schema`, `schema "users" do … end`) → definitions
 *  - migrations (`use Ecto.Migration`, `def change` / `def up`) → migration history
 *
 * Only the `change` / `up` direction of migrations is read; `down` is ignored.
 */

import type {
  Column,
  ColumnPatch,
  EntityRef,
  ParseResult,
  RawEntity,
  RawEnum,
  RawRelation,
  SchemaOp,
  SourceFile,
  SourceRef,
} from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { shortName, snakeCase } from '../core/naming';
import { type Args, Code, boolValue, type Span, stringValue } from '../core/text';
import { addColumn, callArgs, inlineEnumName, listValues } from './shared/rubyphp';

const SCHEMA_MACROS =
  /^[ \t]*(field|belongs_to|has_many|has_one|many_to_many|timestamps|embeds_one|embeds_many)\b/gm;

function detect(file: SourceFile): boolean {
  const t = file.text;
  return t.includes('Ecto.Schema') || t.includes('Ecto.Migration');
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'elixir');
  const isMigration =
    /\buse\s+Ecto\.Migration\b/.test(code.masked) ||
    (/\bEcto\.Migration\b/.test(code.masked) && !/\buse\s+Ecto\.Schema\b/.test(code.masked));
  return isMigration ? parseMigration(file, code) : parseSchema(file, code);
}

// ── schema modules ──────────────────────────────────────────────────────────────────────────

function parseSchema(file: SourceFile, code: Code): ParseResult {
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const enums: RawEnum[] = [];

  // All `defmodule` headers, once (looking backwards from every schema re-scanned the whole file
  // prefix each time, which made large files quadratic).
  const modules = [...code.stripped.matchAll(/\bdefmodule\s+([\w.]+)\s+do\b/g)].map((m) => ({ at: m.index!, name: m[1] }));
  const moduleBefore = (at: number) => {
    let lo = 0;
    let hi = modules.length - 1;
    let found: (typeof modules)[number] | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (modules[mid].at < at) {
        found = modules[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };

  for (const sm of code.stripped.matchAll(/\bschema\s+"([^"\n]+)"\s+do\b/g)) {
    const at = sm.index!;
    if (!code.isCode(at)) continue;
    const table = sm[1].trim();
    const line = code.lineAt(at);
    const block = code.indentedBlock(line);

    const mod = moduleBefore(at);
    const modelName = mod ? shortName(mod.name) : undefined;
    const header = code.stripped.slice(mod ? mod.at : 0, at);
    const cfg = schemaConfig(header);

    const cols: Column[] = [];
    if (cfg.pk) cols.push(column(cfg.pkName, cfg.pkType, { primaryKey: true, nullable: false, generated: true }));

    collectSchemaBody(code, block.start, block.end, {
      table,
      modelName,
      fkType: cfg.fkType,
      file: file.path,
      cols,
      relations,
      enums,
    });

    const entity: RawEntity = {
      name: table,
      kind: 'table',
      modelName,
      nameCertainty: 2,
      columns: cols,
      source: sourceRef(file, line),
    };
    if (cfg.prefix) entity.schema = cfg.prefix;
    entities.push(entity);
  }

  return { entities, relations, enums };
}

interface SchemaCfg {
  pk: boolean;
  pkName: string;
  pkType: string;
  fkType?: string;
  prefix?: string;
}

function schemaConfig(header: string): SchemaCfg {
  const cfg: SchemaCfg = { pk: true, pkName: 'id', pkType: 'bigint' };
  const pkm = /@primary_key\s+(false|\{[^}]*\})/.exec(header);
  if (pkm) {
    if (pkm[1] === 'false') cfg.pk = false;
    else {
      const parts = pkm[1].slice(1, -1).split(',');
      cfg.pkName = stringValue(parts[0]?.trim()) ?? 'id';
      cfg.pkType = stringValue(parts[1]?.trim()) ?? 'bigint';
    }
  }
  const fk = /@foreign_key_type\s+(:[A-Za-z_]\w*)/.exec(header);
  if (fk) cfg.fkType = stringValue(fk[1]);
  const px = /@schema_prefix\s+("[^"\n]+"|:[A-Za-z_]\w*)/.exec(header);
  if (px) cfg.prefix = stringValue(px[1]);
  return cfg;
}

interface BodyCtx {
  table: string;
  modelName?: string;
  fkType?: string;
  file: string;
  cols: Column[];
  relations: RawRelation[];
  enums: RawEnum[];
}

function collectSchemaBody(code: Code, start: number, end: number, ctx: BodyCtx): void {
  const region = code.masked.slice(start, end);
  for (const mm of region.matchAll(SCHEMA_MACROS)) {
    const kw = mm[1];
    const at = start + mm.index! + (mm[0].length - kw.length);
    if (!code.isCode(at)) continue;
    const args = callArgs(code, at + kw.length, end);
    const line = code.lineAt(at);
    const ref: SourceRef = sourceRef(code.text, line);
    if (kw === 'field') schemaField(args, ctx, line);
    else if (kw === 'timestamps') addTimestamps(ctx.cols);
    else if (kw === 'belongs_to') schemaBelongsTo(args, ctx, ref);
    else if (kw === 'has_many') schemaHas(args, ctx, ref, false);
    else if (kw === 'has_one') schemaHas(args, ctx, ref, true);
    else if (kw === 'many_to_many') schemaManyToMany(args, ctx, ref);
    // embeds_one / embeds_many: skipped (not database columns)
  }
}

function schemaField(args: Args, ctx: BodyCtx, line: number): void {
  const name = stringValue(args.positional[0]?.text);
  if (!name) return;
  const typeExpr = args.positional[1]?.text ?? '';
  const props: Partial<Column> = { source: sourceRef(ctx.file, line) };
  const def = args.named.get('default');
  if (def) props.default = def.text;
  const nn = boolValue(args.named.get('null')?.text);
  props.nullable = nn === false ? false : true;
  if (boolValue(args.named.get('primary_key')?.text)) {
    props.primaryKey = true;
    props.nullable = false;
  }

  if (/^Ecto\.Enum\b/.test(typeExpr)) {
    const valuesExpr = args.named.get('values')?.text;
    const values = valuesExpr ? listValues(valuesExpr) : [];
    const enumName = inlineEnumName(ctx.table, name);
    if (values.length) ctx.enums.push({ name: enumName, values, source: sourceRef(ctx.file, line) });
    props.enumRef = enumName;
    addColumn(ctx.cols, column(name, 'enum', props));
    return;
  }
  const { type, isArray } = ectoType(typeExpr);
  if (isArray) props.isArray = true;
  addColumn(ctx.cols, column(name, type, props));
}

function schemaBelongsTo(args: Args, ctx: BodyCtx, ref: SourceRef): void {
  const assoc = stringValue(args.positional[0]?.text);
  if (!assoc) return;
  const targetMod = args.positional[1]?.text;
  const fkName = stringValue(args.named.get('foreign_key')?.text) ?? `${assoc}_id`;
  const fkType = stringValue(args.named.get('type')?.text) ?? ctx.fkType ?? 'bigint';
  const refCol = stringValue(args.named.get('references')?.text);
  const defineField = boolValue(args.named.get('define_field')?.text);
  if (defineField !== false) addColumn(ctx.cols, column(fkName, fkType, { source: ref }));
  const to = refEntity(targetMod);
  if (!to) return;
  ctx.relations.push({
    from: { name: ctx.table, model: ctx.modelName },
    fromColumns: [fkName],
    to,
    toColumns: refCol ? [refCol] : [],
    cardinality: 'many-to-one',
    kind: 'orm',
    source: ref,
  });
}

function schemaHas(args: Args, ctx: BodyCtx, ref: SourceRef, one: boolean): void {
  const assoc = stringValue(args.positional[0]?.text);
  if (!assoc) return;
  const targetMod = args.positional[1]?.text;
  const through = args.named.get('through');
  if (through) return; // has_many :through – association chain, covered by the direct relations
  const target = refEntity(targetMod);
  if (!target) return;
  const fkName = stringValue(args.named.get('foreign_key')?.text) ?? `${snakeCase(ctx.modelName ?? ctx.table)}_id`;
  if (one) {
    // has_one: the FK lives on the child (`target`) and points back to this schema.
    ctx.relations.push({
      from: target,
      fromColumns: [fkName],
      to: { name: ctx.table, model: ctx.modelName },
      toColumns: [],
      cardinality: 'one-to-one',
      kind: 'orm',
      source: ref,
    });
  } else {
    ctx.relations.push({
      from: { name: ctx.table, model: ctx.modelName },
      fromColumns: [],
      to: target,
      toColumns: [fkName],
      cardinality: 'one-to-many',
      kind: 'orm',
      source: ref,
    });
  }
}

function schemaManyToMany(args: Args, ctx: BodyCtx, ref: SourceRef): void {
  const target = refEntity(args.positional[1]?.text);
  if (!target) return;
  const joinExpr = args.named.get('join_through')?.text;
  let through: EntityRef | undefined;
  if (joinExpr) {
    const name = stringValue(joinExpr);
    through = name && !/^[A-Z]/.test(joinExpr.trim()) ? { name } : { model: shortName(joinExpr) };
  }
  ctx.relations.push({
    from: { name: ctx.table, model: ctx.modelName },
    fromColumns: [],
    to: target,
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    through,
    source: ref,
  });
}

/** Target of an association: a module alias (`MyApp.Post`, `Post`). */
function refEntity(expr: string | undefined): EntityRef | undefined {
  if (!expr) return undefined;
  const name = shortName(expr.trim());
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  return { model: name };
}

/** Normalises an Ecto field type: `:string` → `string`, `{:array, :string}` → array of `string`. */
function ectoType(expr: string): { type: string; isArray: boolean } {
  const t = expr.trim();
  const arr = /^\{\s*:array\s*,\s*(.+)\}$/.exec(t);
  if (arr) return { type: ectoType(arr[1].trim()).type, isArray: true };
  const v = stringValue(t);
  return { type: v ?? t, isArray: false };
}

function addTimestamps(cols: Column[]): void {
  addColumn(cols, column('inserted_at', 'naive_datetime', { nullable: false }));
  addColumn(cols, column('updated_at', 'naive_datetime', { nullable: false }));
}

// ── migrations ──────────────────────────────────────────────────────────────────────────────

interface Range {
  start: number;
  end: number;
}

function parseMigration(file: SourceFile, code: Code): ParseResult {
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const enums: RawEnum[] = [];
  const ops: SchemaOp[] = [];
  const m = code.masked;

  const active: Range[] = [];
  for (const dm of m.matchAll(/\bdef\s+(?:change|up)\b/g)) {
    const line = code.lineAt(dm.index!);
    const block = code.indentedBlock(line);
    active.push({ start: block.start, end: block.end });
  }
  if (!active.length) active.push({ start: 0, end: code.text.length });
  const inActive = (at: number) => active.some((r) => at >= r.start && at < r.end);

  // create table / create_if_not_exists table
  for (const cm of m.matchAll(/\b(?:create|create_if_not_exists)\s+table\s*\(/g)) {
    const at = cm.index!;
    if (!inActive(at) || !code.isCode(at)) continue;
    const open = at + cm[0].length - 1;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    if (!name) continue;
    const line = code.lineAt(at);
    const block = code.indentedBlock(line);
    const noPk = boolValue(args.named.get('primary_key')?.text) === false;
    const prefix = stringValue(args.named.get('prefix')?.text);
    const cols: Column[] = [];
    if (!noPk) cols.push(column('id', 'bigint', { primaryKey: true, nullable: false, generated: true }));
    collectMigrationColumns(code, block.start, block.end, name, file.path, cols, relations, ops);
    const entity: RawEntity = { name, kind: 'table', columns: cols, source: sourceRef(file, line) };
    if (prefix) entity.schema = prefix;
    entities.push(entity);
  }

  // alter table
  for (const am of m.matchAll(/\balter\s+table\s*\(/g)) {
    const at = am.index!;
    if (!inActive(at) || !code.isCode(at)) continue;
    const open = at + am[0].length - 1;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    if (!name) continue;
    const line = code.lineAt(at);
    const block = code.indentedBlock(line);
    const cols: Column[] = [];
    collectMigrationColumns(code, block.start, block.end, name, file.path, cols, relations, ops);
    if (cols.length) entities.push({ name, kind: 'table', partial: true, columns: cols, source: sourceRef(file, line) });
  }

  // create index / unique_index
  for (const im of m.matchAll(/\bcreate(?:_if_not_exists)?\s+(unique_index|index)\s*\(/g)) {
    const at = im.index!;
    if (!inActive(at) || !code.isCode(at)) continue;
    const open = at + im[0].length - 1;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    const colsExpr = args.positional[1]?.text;
    if (!name || !colsExpr) continue;
    const columns = listValues(colsExpr);
    if (!columns.length) continue;
    const unique = im[1] === 'unique_index' || boolValue(args.named.get('unique')?.text) === true;
    const idxName = stringValue(args.named.get('name')?.text);
    const line = code.lineAt(at);
    entities.push({
      name,
      kind: 'table',
      partial: true,
      columns: [],
      indexes: [{ columns, unique, ...(idxName ? { name: idxName } : {}), source: sourceRef(file, line) }],
      source: sourceRef(file, line),
    });
  }

  // rename table(...)
  for (const rm of m.matchAll(/\brename\s+table\s*\(/g)) {
    const at = rm.index!;
    if (!inActive(at) || !code.isCode(at)) continue;
    renameStatement(code, at, code.lineAt(at), file.path, ops);
  }

  // drop table / drop_if_exists table
  for (const dm of m.matchAll(/\b(?:drop|drop_if_exists)\s+table\s*\(/g)) {
    const at = dm.index!;
    if (!inActive(at) || !code.isCode(at)) continue;
    const open = at + dm[0].length - 1;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    if (name) ops.push({ op: 'dropTable', table: { name }, source: sourceRef(file, code.lineAt(at)) });
  }

  return { origin: 'migration', entities, relations, enums, ops };
}

function renameStatement(code: Code, at: number, ln: number, file: string, ops: SchemaOp[]): void {
  // rename table(:a), :old, to: :new   |   rename table(:a), to: table(:b)
  const end = Math.min(code.statementEnd(at), code.text.length);
  const stmt = code.slice(at, end);
  const tableName = tableRefName(stmt);
  if (!tableName) return;
  // strip the leading `rename table(:a)` part so argsIn sees :old, to: ...
  const afterTable = stmt.indexOf(')');
  const restStart = at + afterTable + 1;
  const rest = code.argsIn(skipComma(code, restStart), end);
  const toExpr = rest.named.get('to')?.text;
  const oldCol = rest.positional[0] ? stringValue(rest.positional[0].text) : undefined;
  if (oldCol && toExpr) {
    const to = stringValue(toExpr);
    if (to) ops.push({ op: 'renameColumn', table: { name: tableName }, column: oldCol, to, source: sourceRef(file, ln) });
  } else if (toExpr) {
    const to = tableRefName(toExpr) ?? stringValue(toExpr);
    if (to) ops.push({ op: 'renameTable', table: { name: tableName }, to, source: sourceRef(file, ln) });
  }
}

function skipComma(code: Code, at: number): number {
  const m = code.masked;
  let i = at;
  while (i < m.length && (m[i] === ' ' || m[i] === '\t' || m[i] === ',')) i++;
  return i;
}

function tableRefName(text: string): string | undefined {
  const m = /table\s*\(\s*(:[A-Za-z_]\w*|"[^"]+"|'[^']+')/.exec(text);
  return m ? stringValue(m[1]) : undefined;
}

function collectMigrationColumns(
  code: Code,
  start: number,
  end: number,
  table: string,
  file: string,
  cols: Column[],
  relations: RawRelation[],
  ops: SchemaOp[],
): void {
  const region = code.masked.slice(start, end);
  for (const mm of region.matchAll(/^[ \t]*(add|add_if_not_exists|modify|remove|remove_if_exists|timestamps)\b/gm)) {
    const kw = mm[1];
    const at = start + mm.index! + (mm[0].length - kw.length);
    if (!code.isCode(at)) continue;
    const ln = code.lineAt(at);
    if (kw === 'timestamps') {
      addTimestamps(cols);
      continue;
    }
    const args = callArgs(code, at + kw.length, end);
    const name = stringValue(args.positional[0]?.text);
    if (!name) continue;
    if (kw === 'remove' || kw === 'remove_if_exists') {
      ops.push({ op: 'dropColumn', table: { name: table }, column: name, source: sourceRef(file, ln) });
      continue;
    }
    const typeExpr = args.positional[1]?.text ?? '';
    const refName = referencesTarget(code, args.positional[1]);
    if (kw === 'modify') {
      const set: ColumnPatch = {};
      const { type } = ectoType(typeExpr);
      if (type) set.type = type;
      const nn = boolValue(args.named.get('null')?.text);
      if (nn !== undefined) set.nullable = nn;
      const def = args.named.get('default');
      if (def) set.default = def.text;
      ops.push({ op: 'alterColumn', table: { name: table }, column: name, set, source: sourceRef(file, ln) });
      continue;
    }
    // add / add_if_not_exists
    const props: Partial<Column> = { source: sourceRef(file, ln) };
    const nn = boolValue(args.named.get('null')?.text);
    props.nullable = nn === false ? false : true;
    const def = args.named.get('default');
    if (def) props.default = def.text;
    if (boolValue(args.named.get('primary_key')?.text)) {
      props.primaryKey = true;
      props.nullable = false;
    }
    if (refName) {
      // add :org_id, references(:orgs, on_delete: …, type: …, column: …)
      const refArgs = refName.args;
      const refType = stringValue(refArgs.named.get('type')?.text) ?? 'bigint';
      const refTarget = refName.target;
      const refCol = stringValue(refArgs.named.get('column')?.text);
      const onDelete = ectoAction(refArgs.named.get('on_delete')?.text);
      addColumn(cols, column(name, refType, props));
      relations.push({
        from: { name: table },
        fromColumns: [name],
        to: { name: refTarget },
        toColumns: refCol ? [refCol] : [],
        cardinality: 'many-to-one',
        kind: 'foreign-key',
        ...(onDelete ? { onDelete } : {}),
        optional: props.nullable,
        source: sourceRef(file, ln),
      });
      continue;
    }
    const { type, isArray } = ectoType(typeExpr);
    if (isArray) props.isArray = true;
    addColumn(cols, column(name, type, props));
  }
}

interface RefCall {
  target: string;
  args: Args;
}

function referencesTarget(code: Code, span: Span | undefined): RefCall | undefined {
  if (!span || !/^references\s*\(/.test(span.text)) return undefined;
  const open = code.masked.indexOf('(', span.start);
  if (open < 0) return undefined;
  const args = code.args(open);
  const target = stringValue(args.positional[0]?.text);
  if (!target) return undefined;
  return { target, args };
}

function ectoAction(expr: string | undefined): string | undefined {
  const v = stringValue(expr);
  if (!v) return undefined;
  const map: Record<string, string> = {
    delete_all: 'CASCADE',
    nilify_all: 'SET NULL',
    restrict: 'RESTRICT',
    nothing: 'NO ACTION',
  };
  return map[v] ?? v.toUpperCase();
}

export const ectoParser: SchemaParser = {
  kind: 'ecto',
  extensions: ['.ex', '.exs'],
  detect,
  parse,
};
