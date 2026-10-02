/**
 * Bun (Go) schema parser — `github.com/uptrace/bun`.
 *
 * Reads Go structs that embed `bun.BaseModel` or carry `bun:"…"` field tags. The first element of a
 * `bun:` tag is the column name, the rest are options (`pk`, `notnull`, `unique`, `autoincrement`,
 * `type:…`, `default:…`); relations are declared with `rel:belongs-to|has-one|has-many` + `join:…`
 * and `m2m:join_table`. Columns are nullable unless `notnull` or `pk`.
 */

import { type Column, type ParseResult, type RawEntity, type RawRelation, type SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, snakeCase } from '../core/naming';
import { Code, cleanComment } from '../core/text';
import {
  goStructFields,
  goStructs,
  isGoScalarType,
  parseStructTag,
  splitTopLevel,
  type GoField,
  type GoStruct,
} from './shared/gorust';

interface BunTag {
  skip: boolean;
  name?: string;
  flags: Set<string>;
  values: Map<string, string>;
  rel?: string;
  m2m?: string;
  join?: string;
}

function bunTagOf(field: GoField): string | undefined {
  return parseStructTag(field.tag).get('bun');
}

function parseBunTag(value: string | undefined): BunTag {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const tag: BunTag = { skip: false, flags, values };
  if (value === undefined) return tag;
  const tokens = splitTopLevel(value, ',').map((t) => t.trim());
  if (tokens[0] === '-') {
    tag.skip = true;
    return tag;
  }
  tokens.forEach((tok, i) => {
    if (!tok) return;
    const colon = tok.indexOf(':');
    if (colon >= 0) {
      const key = tok.slice(0, colon).trim().toLowerCase();
      const val = tok.slice(colon + 1).trim();
      if (key === 'rel') tag.rel = val;
      else if (key === 'm2m') tag.m2m = val;
      else if (key === 'join') tag.join = tag.join ? `${tag.join};${val}` : val;
      else values.set(key, val);
    } else if (i === 0) tag.name = tok;
    else flags.add(tok.toLowerCase());
  });
  return tag;
}

function buildColumn(fieldName: string, field: GoField, tag: BunTag, file: string): Column {
  const base = field.type;
  const name = tag.name ?? snakeCase(fieldName);
  const primaryKey = fieldName === 'ID' || tag.flags.has('pk');
  const nullable = !(tag.flags.has('notnull') || primaryKey);
  const props: Partial<Column> = { nullable, primaryKey, unique: tag.flags.has('unique'), source: { file, line: field.line } };
  if (tag.flags.has('autoincrement')) props.generated = true;
  if (tag.values.has('default')) props.default = tag.values.get('default');
  if (field.isArray && base !== 'byte') props.isArray = true;
  return column(name, tag.values.get('type') ?? base, props);
}

function buildRelation(file: string, struct: GoStruct, field: GoField, tag: BunTag): RawRelation | undefined {
  const assoc = field.type;
  const fieldName = field.names[0] ?? assoc;
  const src = sourceRef(file, field.line);
  if (tag.m2m) {
    return { from: { model: struct.name }, fromColumns: [], to: { model: assoc }, toColumns: [], cardinality: 'many-to-many', through: { name: tag.m2m }, kind: 'orm', source: src };
  }
  const first = tag.join ? tag.join.split(';')[0] : '';
  const [local, foreign] = first.includes('=') ? first.split('=').map((s) => s.trim()) : ['', ''];
  // Bun conventions when `join:` is omitted: belongs-to FK is `<field>_id` on this table; has-one /
  // has-many FK is `<owner-struct>_id` on the related table.
  const ownerFk = snakeCase(`${struct.name}ID`);
  const belongsToFk = snakeCase(`${fieldName}ID`);
  switch (tag.rel) {
    case 'belongs-to':
      return { from: { model: struct.name }, fromColumns: local ? [local] : [belongsToFk], to: { model: assoc }, toColumns: foreign ? [foreign] : [], cardinality: 'many-to-one', kind: 'orm', source: src };
    case 'has-one':
      return { from: { model: assoc }, fromColumns: foreign ? [foreign] : [ownerFk], to: { model: struct.name }, toColumns: local ? [local] : [], cardinality: 'one-to-one', kind: 'orm', source: src };
    case 'has-many':
      return { from: { model: struct.name }, fromColumns: local ? [local] : [], to: { model: assoc }, toColumns: foreign ? [foreign] : [ownerFk], cardinality: 'one-to-many', kind: 'orm', source: src };
    default:
      return undefined;
  }
}

function tableFromBaseModel(fields: GoField[]): string | undefined {
  for (const f of fields) {
    if (f.embedded && f.type === 'bun.BaseModel') {
      const tag = parseBunTag(bunTagOf(f));
      return tag.values.get('table');
    }
  }
  return undefined;
}

function detect(file: SourceFile): boolean {
  const t = file.text;
  return t.includes('uptrace/bun') || t.includes('bun.BaseModel') || /`[^`]*\bbun:"/.test(t);
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'go');
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];

  for (const struct of goStructs(code)) {
    const fields = goStructFields(code, struct.open);
    const hasBaseModel = fields.some((f) => f.embedded && f.type === 'bun.BaseModel');
    const hasBunTags = fields.some((f) => parseStructTag(f.tag).has('bun'));
    if (!hasBaseModel && !hasBunTags) continue;

    const explicit = tableFromBaseModel(fields);
    const columns: Column[] = [];
    for (const field of fields) {
      if (field.embedded || !field.names.length) continue;
      const bunVal = bunTagOf(field);
      if (bunVal === '-') continue;
      const tag = parseBunTag(bunVal);
      if (tag.skip) continue;
      if (tag.rel || tag.m2m) {
        const rel = buildRelation(file.path, struct, field, tag);
        if (rel) relations.push(rel);
        continue;
      }
      const scalar = isGoScalarType({ pointer: field.pointer, isArray: field.isArray, base: field.type });
      if (!scalar && bunVal === undefined) continue; // struct-typed field without a bun column tag
      for (const fieldName of field.names) {
        const col = buildColumn(fieldName, field, tag, file.path);
        if (!columns.some((c) => c.name === col.name)) columns.push(col);
      }
    }

    const entity: RawEntity = {
      name: explicit ?? defaultTableName('bun', struct.name),
      kind: 'table',
      modelName: struct.name,
      nameCertainty: explicit ? 2 : 0,
      columns,
      source: sourceRef(file, struct.line),
    };
    const comment = cleanComment(code.leadingComments(code.lineStart(struct.line)).join('\n'));
    if (comment) entity.comment = comment;
    entities.push(entity);
  }

  return { entities, relations, enums: [] };
}

export const bunParser: SchemaParser = {
  kind: 'bun',
  extensions: ['.go'],
  detect,
  parse,
};
