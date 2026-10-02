/**
 * SeaORM (Rust) schema parser — `sea_orm`.
 *
 * Each entity lives in its own module (`src/entity/cake.rs`): a `#[derive(DeriveEntityModel)]`
 * `struct Model` with `#[sea_orm(table_name = "cake")]`, fields → columns (`Option<T>` → nullable,
 * `column_name` / `column_type` overrides), and a `#[derive(DeriveRelation)] enum Relation` whose
 * `belongs_to` / `has_many` / `has_one` variants become relations targeting `super::<module>::Entity`.
 * `#[derive(DeriveActiveEnum)]` enums become enums. The module name is the model name.
 */

import { type Column, type ParseResult, type RawEntity, type RawEnum, type RawRelation, type SourceFile } from '../core/model';
import { baseName, column, extOf, sourceRef, type SchemaParser } from '../core/parser';
import { snakeCase } from '../core/naming';
import { Code, stringValue } from '../core/text';
import { parseRustArgs, rustEnumVariants, rustItems, rustStructFields, type RustArgs } from './shared/gorust';

const SKIP_MODULES = new Set(['mod', 'lib', 'prelude', 'main']);

function moduleName(path: string): string {
  const base = baseName(path);
  const ext = extOf(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** Module referenced by `super::cake::Entity` / `crate::entity::fruit::Entity` → `cake` / `fruit`. */
function targetModule(value: string | undefined): string | undefined {
  const s = stringValue(value) ?? value;
  if (!s) return undefined;
  const m = /(\w+)\s*::\s*Entity\b/.exec(s);
  return m ? m[1] : undefined;
}

/** `Column::CakeId` / `super::cake::Column::Id` → `cake_id` / `id`. */
function columnName(value: string | undefined): string | undefined {
  const s = stringValue(value) ?? value;
  if (!s) return undefined;
  const matches = [...s.matchAll(/Column\s*::\s*(\w+)/g)];
  const last = matches[matches.length - 1];
  return last ? snakeCase(last[1]) : undefined;
}

function mapOnAction(value: string | undefined): string | undefined {
  const s = stringValue(value) ?? value;
  switch (s?.trim()) {
    case 'Cascade':
      return 'CASCADE';
    case 'SetNull':
      return 'SET NULL';
    case 'Restrict':
      return 'RESTRICT';
    case 'NoAction':
      return 'NO ACTION';
    case 'SetDefault':
      return 'SET DEFAULT';
    default:
      return s?.trim() || undefined;
  }
}

const INT_TYPE_RE = /^(i8|i16|i32|i64|u8|u16|u32|u64|isize|usize)$/;

function buildColumn(file: string, fieldName: string, rawType: string, optional: boolean, args: RustArgs, line: number): Column {
  const name = stringValue(args.named.get('column_name')) ?? snakeCase(fieldName);
  const primaryKey = args.flags.has('primary_key');
  const nullable = !primaryKey && (optional || args.flags.has('nullable'));
  const type = stringValue(args.named.get('column_type')) ?? rawType;
  const props: Partial<Column> = { nullable, primaryKey, unique: args.flags.has('unique'), source: { file, line } };
  if (primaryKey && args.named.get('auto_increment')?.trim() !== 'false' && INT_TYPE_RE.test(rawType)) props.generated = true;
  const def = args.named.get('default_value');
  if (def !== undefined) props.default = stringValue(def) ?? def.trim();
  return column(name, type, props);
}

function detect(file: SourceFile): boolean {
  const t = file.text;
  return t.includes('sea_orm') && (t.includes('DeriveEntityModel') || t.includes('DeriveActiveEnum') || t.includes('DeriveRelation'));
}

function parse(file: SourceFile): ParseResult {
  const module = moduleName(file.path);
  if (SKIP_MODULES.has(module.toLowerCase())) return { entities: [], relations: [], enums: [] };

  const code = new Code(file.text, 'rust');
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const enums: RawEnum[] = [];

  for (const item of rustItems(code)) {
    if (item.open < 0) continue;

    if (item.kind === 'struct' && item.derives.includes('DeriveEntityModel')) {
      const attr = parseRustArgs(item.seaOrm);
      const tableName = stringValue(attr.named.get('table_name'));
      const schema = stringValue(attr.named.get('schema_name'));
      const columns: Column[] = [];
      for (const field of rustStructFields(code, item.open)) {
        const col = buildColumn(file.path, field.name, field.type, field.optional, parseRustArgs(field.seaOrm), field.line);
        if (!columns.some((c) => c.name === col.name)) columns.push(col);
      }
      const entity: RawEntity = {
        name: tableName ?? module,
        kind: 'table',
        modelName: module,
        nameCertainty: tableName ? 2 : 0,
        columns,
        source: sourceRef(file, item.line),
      };
      if (schema) entity.schema = schema;
      entities.push(entity);
      continue;
    }

    if (item.kind === 'enum' && item.derives.includes('DeriveRelation')) {
      for (const variant of rustEnumVariants(code, item.open)) {
        const args = parseRustArgs(variant.seaOrm);
        const src = sourceRef(file, variant.line);
        const onDelete = mapOnAction(args.named.get('on_delete'));
        const onUpdate = mapOnAction(args.named.get('on_update'));
        const extra: Partial<RawRelation> = {};
        if (onDelete) extra.onDelete = onDelete;
        if (onUpdate) extra.onUpdate = onUpdate;

        const belongsTo = targetModule(args.named.get('belongs_to'));
        if (belongsTo) {
          const fromCol = columnName(args.named.get('from'));
          const toCol = columnName(args.named.get('to'));
          relations.push({
            from: { model: module },
            fromColumns: fromCol ? [fromCol] : [],
            to: { model: belongsTo },
            toColumns: toCol ? [toCol] : [],
            cardinality: 'many-to-one',
            kind: 'orm',
            source: src,
            ...extra,
          });
          continue;
        }
        const hasMany = targetModule(args.named.get('has_many'));
        if (hasMany) {
          relations.push({ from: { model: module }, fromColumns: [], to: { model: hasMany }, toColumns: [], cardinality: 'one-to-many', kind: 'orm', source: src, ...extra });
          continue;
        }
        const hasOne = targetModule(args.named.get('has_one'));
        if (hasOne) {
          relations.push({ from: { model: hasOne }, fromColumns: [], to: { model: module }, toColumns: [], cardinality: 'one-to-one', kind: 'orm', source: src, ...extra });
        }
      }
      continue;
    }

    if (item.kind === 'enum' && item.derives.includes('DeriveActiveEnum')) {
      const attr = parseRustArgs(item.seaOrm);
      const name = stringValue(attr.named.get('enum_name')) ?? snakeCase(item.name);
      const values: string[] = [];
      for (const variant of rustEnumVariants(code, item.open)) {
        const args = parseRustArgs(variant.seaOrm);
        const sv = stringValue(args.named.get('string_value'));
        const nv = args.named.get('num_value');
        if (sv) values.push(sv);
        else if (nv) values.push(nv.trim());
        else values.push(variant.name);
      }
      enums.push({ name, values, source: sourceRef(file, item.line) });
    }
  }

  return { entities, relations, enums };
}

export const seaormParser: SchemaParser = {
  kind: 'seaorm',
  extensions: ['.rs'],
  detect,
  parse,
};
