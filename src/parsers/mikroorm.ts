/**
 * MikroORM schema parser (`kind: 'mikroorm'`, definition origin).
 *
 * Reads `@Entity` classes and abstract bases, `@PrimaryKey` / `@Property` / `@Enum` columns and
 * `@ManyToOne` / `@OneToOne` / `@OneToMany` / `@ManyToMany` relations (with `@Unique` / `@Index`),
 * plus the `new EntitySchema({ … })` form. Default UnderscoreNamingStrategy: snake_case tables and
 * columns, FK `${snake(property)}_id`, pivot `${table}_${snake(property)}`.
 */

import type { Column, ParseResult, RawEntity, RawEnum, RawRelation, SourceFile } from '../core/model';
import { column, type SchemaParser } from '../core/parser';
import { boolValue, Code, stringValue } from '../core/text';
import { defaultTableName, shortName, snakeCase } from '../core/naming';
import {
  type ClassDecl,
  type Decorator,
  docComment,
  findClasses,
  findDecorator,
  importsFrom,
  type MemberDecl,
  members,
  normalizeTsType,
} from './shared/jsorm';

const KIND = 'mikroorm' as const;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

const COLUMN_DECORATORS = ['Property', 'PrimaryKey', 'SerializedPrimaryKey', 'Enum'];
const RELATION_DECORATORS = ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany'];

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/@mikro-orm\//.test(t)) {
    return /@(?:Entity|PrimaryKey|Property|Enum|ManyToOne|OneToMany|OneToOne|ManyToMany)\b/.test(t) || /\bEntitySchema\b/.test(t) || /\bdefineEntity\b/.test(t);
  }
  // Fallback without the import: MikroORM-only markers and no TypeORM `@Column`.
  if (!importsFrom(t, /typeorm/) && /@PrimaryKey\b/.test(t) && /@Property\b/.test(t) && !/@Column\b/.test(t)) return true;
  return false;
}

function optionsOf(code: Code, open: number): Map<string, { start: number; end: number; text: string }> | undefined {
  if (open < 0) return undefined;
  for (const p of code.args(open).positional) {
    if (p.text.startsWith('{')) return code.object(p.start);
  }
  return undefined;
}

/** Target model of a relation: `() => Author`, `'Author'`, or an options `{ entity: () => Author }`. */
function targetModel(code: Code, dec: Decorator): string | undefined {
  if (dec.open < 0) return undefined;
  const args = code.args(dec.open);
  for (const p of args.positional) {
    if (p.text.startsWith('{')) continue;
    const t = fromExpr(p.text);
    if (t) return t;
  }
  const entity = optionsOf(code, dec.open)?.get('entity');
  return entity ? fromExpr(entity.text) : undefined;
}

function fromExpr(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const s = text.trim();
  const str = stringValue(s);
  if (str) return shortName(str);
  const arrow = /=>\s*([A-Za-z_$][\w$.]*)/.exec(s);
  if (arrow) return shortName(arrow[1].replace(/\[\]$/, ''));
  const id = /^([A-Za-z_$][\w$.]*)/.exec(s);
  return id ? shortName(id[1].replace(/\[\]$/, '')) : undefined;
}

function entityInfo(code: Code, cls: ClassDecl): { name: string; schema?: string; certainty: 0 | 2 } | undefined {
  const dec = findDecorator(cls.decorators, 'Entity');
  if (!dec) return undefined;
  let name = defaultTableName(KIND, cls.name);
  let certainty: 0 | 2 = 0;
  let schema: string | undefined;
  const opts = optionsOf(code, dec.open);
  if (opts) {
    const tn = opts.get('tableName') ?? opts.get('collection');
    const s = tn && stringValue(tn.text);
    if (s) {
      name = s;
      certainty = 2;
    }
    const sc = opts.get('schema') && stringValue(opts.get('schema')!.text);
    if (sc) schema = sc;
  }
  return { name, schema, certainty };
}

function buildColumn(code: Code, file: SourceFile, member: MemberDecl, dec: Decorator): { col: Column; enumValues?: string[]; enumName?: string } {
  const ts = normalizeTsType(member.type);
  const opts = optionsOf(code, dec.open);
  const src = { file: file.path, line: member.line };
  let name = (opts?.get('fieldName') && stringValue(opts.get('fieldName')!.text)) || snakeCase(member.name);
  const props: Partial<Column> = { source: src };
  let type = (opts?.get('columnType') && stringValue(opts.get('columnType')!.text)) || (opts?.get('type') && stringValue(opts.get('type')!.text)) || ts.type;
  let nullable = boolValue(opts?.get('nullable')?.text) ?? false;
  let enumValues: string[] | undefined;
  let enumName: string | undefined;

  if (dec.name === 'PrimaryKey' || dec.name === 'SerializedPrimaryKey') {
    props.primaryKey = true;
    nullable = false;
    if (!type) type = ts.type || 'int';
    if (!boolValue(opts?.get('autoincrement')?.text) && (type === 'int' || type === 'number' || type === 'bigint' || ts.type === 'number')) {
      props.generated = true;
    } else if (boolValue(opts?.get('autoincrement')?.text)) {
      props.generated = true;
    }
  } else if (dec.name === 'Enum') {
    const items = enumItems(code, dec);
    if (items.inline) {
      enumValues = items.inline;
      enumName = `${snakeCase(member.name)}_enum`;
      props.enumRef = enumName;
      type = 'enum';
    } else if (items.ref) {
      props.enumRef = items.ref;
      type = type || items.ref;
    }
  }

  if (boolValue(opts?.get('unique')?.text)) props.unique = true;
  if (ts.isArray) props.isArray = true;
  const def = opts?.get('default') ?? opts?.get('defaultRaw');
  if (def) props.default = def.text;
  if (type && props.isArray && !/\[\]$/.test(type)) type = `${type}[]`;

  const anchor = member.decorators.reduce((min, d) => Math.min(min, d.line), member.line);
  const doc = docComment(code, code.lineStart(anchor));
  if (doc) props.comment = doc;
  return { col: column(name, type ?? '', { ...props, nullable }), enumValues, enumName };
}

function enumItems(code: Code, dec: Decorator): { inline?: string[]; ref?: string } {
  if (dec.open < 0) return {};
  const args = code.args(dec.open);
  for (const p of args.positional) {
    if (p.text.startsWith('{')) {
      const items = code.object(p.start).get('items');
      if (items?.text.startsWith('[')) return { inline: readStringArray(code, items.start) };
      if (items) return { ref: fromExpr(items.text) };
    } else {
      const ref = fromExpr(p.text);
      if (ref) return { ref };
    }
  }
  return {};
}

function readStringArray(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const it of code.items(open)) {
    const v = stringValue(it.text);
    if (v !== undefined) out.push(v);
  }
  return out;
}

function parseRelation(
  code: Code,
  file: SourceFile,
  member: MemberDecl,
  dec: Decorator,
  entity: { name: string; model: string },
  out: { relations: RawRelation[]; columns: Column[] },
): void {
  const target = targetModel(code, dec);
  if (!target) return;
  const opts = optionsOf(code, dec.open);
  const nullable = boolValue(opts?.get('nullable')?.text);
  const onDelete = stringValue(opts?.get('deleteRule')?.text) ?? stringValue(opts?.get('onDelete')?.text);
  const mappedBy = opts?.get('mappedBy');
  const owner = boolValue(opts?.get('owner')?.text);
  const src = { file: file.path, line: member.line };

  if (dec.name === 'OneToMany') {
    out.relations.push({ from: { model: entity.model, name: entity.name }, fromColumns: [], to: { model: target }, toColumns: [], cardinality: 'one-to-many', kind: 'orm', source: src });
    return;
  }
  if (dec.name === 'ManyToMany') {
    if (mappedBy && owner !== true) return; // inverse side
    const pivot = (opts?.get('pivotTable') && stringValue(opts.get('pivotTable')!.text)) || snakeCase(`${entity.name}_${member.name}`);
    out.relations.push({ from: { model: entity.model, name: entity.name }, fromColumns: [], to: { model: target }, toColumns: [], cardinality: 'many-to-many', kind: 'orm', through: { name: pivot }, source: src });
    return;
  }
  if (dec.name === 'OneToOne' && mappedBy && owner !== true) return; // inverse side

  const fkName = (opts?.get('fieldName') && stringValue(opts.get('fieldName')!.text)) || `${snakeCase(member.name)}_id`;
  const colNullable = nullable ?? dec.name !== 'OneToOne';
  if (!out.columns.some((c) => c.name.toLowerCase() === fkName.toLowerCase())) {
    out.columns.push(column(fkName, '', { nullable: colNullable, source: src }));
  }
  out.relations.push({
    from: { model: entity.model, name: entity.name },
    fromColumns: [fkName],
    to: { model: target },
    toColumns: [],
    cardinality: dec.name === 'OneToOne' ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    ...(onDelete ? { onDelete } : {}),
    optional: colNullable,
    source: src,
  });
}

function parseEntitySchemas(code: Code, file: SourceFile, result: ParseResult): void {
  const m = code.masked;
  const re = /\bnew\s+EntitySchema\s*\(/g;
  for (const match of m.matchAll(re)) {
    const open = m.indexOf('(', match.index + match[0].length - 1);
    if (open < 0) continue;
    const objSpan = code.args(open).positional.find((p) => p.text.startsWith('{'));
    if (!objSpan) continue;
    const obj = code.object(objSpan.start);
    const modelName = obj.get('name') && stringValue(obj.get('name')!.text);
    const tableSpan = obj.get('tableName') ?? obj.get('collection');
    const tableName = tableSpan && stringValue(tableSpan.text);
    const name = tableName || (modelName ? defaultTableName(KIND, modelName) : undefined);
    if (!name) continue;
    const line = code.lineAt(match.index);
    const columns: Column[] = [];
    const propsSpan = obj.get('properties');
    if (propsSpan?.text.startsWith('{')) {
      for (const [prop, span] of code.object(propsSpan.start)) {
        if (!span.text.startsWith('{')) continue;
        const def = code.object(span.start);
        const colName = (def.get('fieldName') && stringValue(def.get('fieldName')!.text)) || snakeCase(prop);
        const primary = boolValue(def.get('primary')?.text) === true;
        columns.push(
          column(colName, stringValue(def.get('type')?.text) ?? '', {
            primaryKey: primary,
            nullable: primary ? false : boolValue(def.get('nullable')?.text) ?? false,
            unique: boolValue(def.get('unique')?.text) === true,
            source: { file: file.path, line },
          }),
        );
      }
    }
    result.entities.push({
      name,
      ...(obj.get('schema') && stringValue(obj.get('schema')!.text) ? { schema: stringValue(obj.get('schema')!.text)! } : {}),
      kind: 'table',
      modelName: modelName || undefined,
      nameCertainty: tableName ? 2 : 0,
      columns,
      source: { file: file.path, line },
    });
  }
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'js');
  const result: ParseResult = { entities: [], relations: [], enums: [] };

  for (const cls of findClasses(code)) {
    const info = entityInfo(code, cls);
    const classMembers = members(code, cls.bodyOpen, cls.bodyClose, { decorators: true });
    const hasDecorator = classMembers.some((mem) => findDecorator(mem.decorators, ...COLUMN_DECORATORS, ...RELATION_DECORATORS));
    if (!info && !hasDecorator) continue;

    const entityName = info ? info.name : defaultTableName(KIND, cls.name);
    const columns: Column[] = [];
    const relations: RawRelation[] = [];
    const enums: RawEnum[] = [];

    for (const mem of classMembers) {
      const relDec = findDecorator(mem.decorators, ...RELATION_DECORATORS);
      if (relDec) {
        parseRelation(code, file, mem, relDec, { name: entityName, model: cls.name }, { relations, columns });
        continue;
      }
      const colDec = findDecorator(mem.decorators, ...COLUMN_DECORATORS);
      if (!colDec) continue;
      const { col, enumValues, enumName } = buildColumn(code, file, mem, colDec);
      if (findDecorator(mem.decorators, 'Unique')) col.unique = true;
      columns.push(col);
      if (enumValues && enumName) enums.push({ name: enumName, values: enumValues, source: { file: file.path, line: mem.line } });
    }

    if (!columns.length && !relations.length && !info) continue;

    const entity: RawEntity = {
      name: entityName,
      kind: 'table',
      modelName: cls.name,
      nameCertainty: info?.certainty ?? 0,
      columns,
      source: { file: file.path, line: cls.line },
    };
    if (info?.schema) entity.schema = info.schema;
    if (!info) entity.abstract = true;
    if (cls.extendsName) entity.extends = [cls.extendsName];
    const anchor = cls.decorators.reduce((min, d) => Math.min(min, d.line), cls.line);
    const doc = docComment(code, code.lineStart(anchor));
    if (doc) entity.comment = doc;

    result.entities.push(entity);
    result.relations.push(...relations);
    result.enums.push(...enums);
  }

  parseEntitySchemas(code, file, result);
  return result;
}

export const mikroormParser: SchemaParser = { kind: KIND, extensions: EXTENSIONS, detect, parse };
