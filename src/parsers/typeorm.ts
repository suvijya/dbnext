/**
 * TypeORM schema parser (`kind: 'typeorm'`, definition origin).
 *
 * Reads `@Entity` / `@ViewEntity` / `@ChildEntity` classes, abstract base classes, column decorators
 * (`@Column`, `@PrimaryGeneratedColumn`, `@PrimaryColumn`, date/version columns), relation decorators
 * (`@ManyToOne`, `@OneToOne`, `@OneToMany`, `@ManyToMany` + `@JoinColumn` / `@JoinTable`), class/property
 * `@Index` / `@Unique`, and the `new EntitySchema({ … })` form.
 */

import type { Column, ParseResult, RawEntity, RawEnum, RawRelation, SourceFile } from '../core/model';
import { column, type SchemaParser } from '../core/parser';
import { boolValue, Code, numberValue, stringValue } from '../core/text';
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
} from './shared/jsorm';

const KIND = 'typeorm' as const;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

const ENTITY_DECORATORS = ['Entity', 'ViewEntity', 'ChildEntity'];
const COLUMN_DECORATORS = [
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'ObjectIdColumn',
];
const RELATION_DECORATORS = ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany'];

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (!t.includes('@') && !t.includes('EntitySchema')) return false;
  if (/sequelize-typescript/.test(t)) return false;
  const typeorm = importsFrom(t, /typeorm/) || /@nestjs\/typeorm/.test(t);
  const mikro = /@mikro-orm\//.test(t);
  if (mikro && !typeorm) return false;
  const hasEntity = /@(?:Entity|ViewEntity|ChildEntity)\b/.test(t) || /\bEntitySchema\b/.test(t);
  const typeormCol = /@(?:PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|VersionColumn|ObjectIdColumn)\b/.test(t);
  if (typeorm && (hasEntity || /@Column\b/.test(t) || typeormCol)) return true;
  // Fallback when the import is re-exported: strong TypeORM-only markers.
  if (!typeorm && !mikro && (typeormCol || (/@Entity\b/.test(t) && /@Column\b/.test(t)))) return true;
  return false;
}

interface TypeInfo {
  type: string;
  isArray: boolean;
}

/** Normalises a TS type annotation into a column type (drops `| null`, detects arrays). */
function typeFromTs(raw: string): TypeInfo {
  let t = raw.trim();
  if (!t) return { type: '', isArray: false };
  t = t.replace(/\|\s*(?:null|undefined)\b/g, '').replace(/\b(?:null|undefined)\s*\|/g, '').trim();
  let isArray = false;
  const arr = /^Array<(.+)>$/.exec(t);
  if (arr) {
    isArray = true;
    t = arr[1].trim();
  } else if (/\[\]$/.test(t)) {
    isArray = true;
    t = t.replace(/\[\]$/, '').trim();
  }
  // Keep simple scalar names; ignore complex unions / generics.
  if (/[<>{}|&]/.test(t)) return { type: '', isArray };
  return { type: t, isArray };
}

/** Reads the options object literal passed to a decorator / column, or undefined. */
function optionsOf(code: Code, open: number): Map<string, { start: number; end: number; text: string }> | undefined {
  if (open < 0) return undefined;
  for (const p of code.args(open).positional) {
    if (p.text.startsWith('{')) return code.object(p.start);
  }
  return undefined;
}

/** Target model name of a relation decorator from its first argument (`() => Post`, `'Post'`, `Post`). */
function targetModel(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const s = text.trim();
  const str = stringValue(s);
  if (str) return shortName(str);
  const arrow = /=>\s*([A-Za-z_$][\w$.]*)/.exec(s);
  if (arrow) return shortName(arrow[1].replace(/\[\]$/, ''));
  const id = /^([A-Za-z_$][\w$.]*)/.exec(s);
  return id ? shortName(id[1].replace(/\[\]$/, '')) : undefined;
}

function entityInfo(code: Code, cls: ClassDecl): { kind: RawEntity['kind']; name: string; schema?: string; certainty: 0 | 2; dec: Decorator } | undefined {
  const dec = findDecorator(cls.decorators, ...ENTITY_DECORATORS);
  if (!dec) return undefined;
  const kind: RawEntity['kind'] = dec.name === 'ViewEntity' ? 'view' : 'table';
  let name = defaultTableName(KIND, cls.name);
  let certainty: 0 | 2 = 0;
  let schema: string | undefined;
  if (dec.name !== 'ChildEntity' && dec.open >= 0) {
    const args = code.args(dec.open);
    const first = args.positional[0];
    if (first?.text.startsWith('{')) {
      const obj = code.object(first.start);
      const n = obj.get('name') && stringValue(obj.get('name')!.text);
      if (n) {
        name = n;
        certainty = 2;
      }
      const s = obj.get('schema') && stringValue(obj.get('schema')!.text);
      if (s) schema = s;
    } else if (first) {
      const n = stringValue(first.text);
      if (n) {
        name = n;
        certainty = 2;
      }
    }
  }
  return { kind, name, schema, certainty, dec };
}

interface ColumnResult {
  col: Column;
  enumValues?: string[];
}

function buildColumn(code: Code, file: SourceFile, member: MemberDecl, dec: Decorator, entityName: string): ColumnResult {
  const ts = typeFromTs(member.type);
  const props: Partial<Column> = { source: { file: file.path, line: member.line } };
  let name = member.name;
  let type = '';
  let nullable = false;
  const options = optionsOf(code, dec.open);
  const positionalType = dec.open >= 0 ? code.args(dec.open).positional.find((p) => !p.text.startsWith('{') && stringValue(p.text) !== undefined) : undefined;
  let enumValues: string[] | undefined;

  const readName = () => {
    const n = options?.get('name');
    if (n) {
      const s = stringValue(n.text);
      if (s) name = s;
    }
  };

  switch (dec.name) {
    case 'PrimaryGeneratedColumn': {
      props.primaryKey = true;
      props.generated = true;
      nullable = false;
      const strategy = positionalType ? stringValue(positionalType.text) : undefined;
      type = strategy === 'uuid' ? 'uuid' : ts.type || 'int';
      readName();
      break;
    }
    case 'ObjectIdColumn':
      props.primaryKey = true;
      type = ts.type || 'ObjectId';
      nullable = false;
      readName();
      break;
    case 'CreateDateColumn':
    case 'UpdateDateColumn':
      type = optStringType(options) || ts.type || 'timestamp';
      nullable = false;
      readName();
      break;
    case 'DeleteDateColumn':
      type = optStringType(options) || ts.type || 'timestamp';
      nullable = true;
      readName();
      break;
    case 'VersionColumn':
      type = optStringType(options) || ts.type || 'int';
      nullable = false;
      readName();
      break;
    case 'PrimaryColumn':
      props.primaryKey = true;
      nullable = false;
      type = resolveColumnType(options, positionalType, ts);
      readName();
      break;
    default: {
      // @Column
      type = resolveColumnType(options, positionalType, ts);
      nullable = boolValue(options?.get('nullable')?.text) ?? false;
      if (boolValue(options?.get('primary')?.text)) {
        props.primaryKey = true;
        nullable = false;
      }
      if (boolValue(options?.get('unique')?.text)) props.unique = true;
      if (boolValue(options?.get('array')?.text) || ts.isArray) props.isArray = true;
      const def = options?.get('default');
      if (def) props.default = def.text;
      const comment = options?.get('comment');
      if (comment) {
        const c = stringValue(comment.text);
        if (c) props.comment = c;
      }
      readName();
      // enum
      const en = options?.get('enum');
      if (en) {
        const arr = enumArray(code, en);
        if (arr) {
          enumValues = arr;
          const enumName = `${entityName}_${name}_enum`;
          props.enumRef = enumName;
          type = type && type !== 'enum' ? type : 'enum';
        } else if (/^[A-Za-z_$]/.test(en.text)) {
          props.enumRef = shortName(en.text);
        }
      }
      break;
    }
  }
  if (props.isArray && type && !/\[\]$/.test(type)) type = `${type}[]`;
  const anchor = member.decorators.reduce((min, d) => Math.min(min, d.line), member.line);
  const doc = docComment(code, code.lineStart(anchor));
  if (doc && props.comment === undefined) props.comment = doc;
  const col = column(name, type, { ...props, nullable });
  return { col, enumValues };
}

function optStringType(options: ReturnType<typeof optionsOf>): string | undefined {
  const t = options?.get('type');
  return t ? stringValue(t.text) : undefined;
}

function resolveColumnType(options: ReturnType<typeof optionsOf>, positionalType: { text: string } | undefined, ts: TypeInfo): string {
  let type = (positionalType ? stringValue(positionalType.text) : undefined) ?? optStringType(options) ?? ts.type;
  if (!type) return '';
  const len = numberValue(options?.get('length')?.text);
  const prec = numberValue(options?.get('precision')?.text);
  const scale = numberValue(options?.get('scale')?.text);
  if (len != null) type = `${type}(${len})`;
  else if (prec != null) type = scale != null ? `${type}(${prec},${scale})` : `${type}(${prec})`;
  return type;
}

function enumArray(code: Code, span: { start: number; text: string }): string[] | undefined {
  if (!span.text.startsWith('[')) return undefined;
  const open = span.start;
  const values: string[] = [];
  for (const item of code.items(open)) {
    const v = stringValue(item.text);
    if (v !== undefined) values.push(v);
  }
  return values.length ? values : undefined;
}

/** Parses `@ManyToOne` / `@OneToOne` / `@OneToMany` / `@ManyToMany` on a member. */
function parseRelation(
  code: Code,
  file: SourceFile,
  member: MemberDecl,
  dec: Decorator,
  entity: { name: string; model: string },
  out: { relations: RawRelation[]; columns: Column[] },
): void {
  const args = dec.open >= 0 ? code.args(dec.open) : undefined;
  const target = targetModel(args?.positional[0]?.text);
  if (!target) return;
  const options = optionsOf(code, dec.open);
  const nullable = boolValue(options?.get('nullable')?.text);
  const onDelete = stringValue(options?.get('onDelete')?.text);
  const onUpdate = stringValue(options?.get('onUpdate')?.text);
  const src = { file: file.path, line: member.line };
  const joinCol = findDecorator(member.decorators, 'JoinColumn');
  const joinTable = findDecorator(member.decorators, 'JoinTable');

  if (dec.name === 'OneToMany') {
    out.relations.push({
      from: { model: entity.model, name: entity.name },
      fromColumns: [],
      to: { model: target },
      toColumns: [],
      cardinality: 'one-to-many',
      kind: 'orm',
      source: src,
    });
    return;
  }

  if (dec.name === 'ManyToMany') {
    if (!joinTable) return; // inverse side
    const jt = optionsOf(code, joinTable.open);
    const explicit = jt?.get('name') && stringValue(jt.get('name')!.text);
    const name = explicit || snakeCase(`${entity.name}_${member.name}_${defaultTableName(KIND, target)}`);
    out.relations.push({
      from: { model: entity.model, name: entity.name },
      fromColumns: [],
      to: { model: target },
      toColumns: [],
      cardinality: 'many-to-many',
      kind: 'orm',
      through: { name },
      source: src,
    });
    return;
  }

  // ManyToOne / OneToOne owning side.
  if (dec.name === 'OneToOne' && !joinCol && boolValue(options?.get('owner')?.text) !== true) return; // inverse side
  const jc = optionsOf(code, joinCol?.open ?? -1);
  const fkName = (jc?.get('name') && stringValue(jc.get('name')!.text)) || `${member.name}Id`;
  const refCol = jc?.get('referencedColumnName') && stringValue(jc.get('referencedColumnName')!.text);
  const colNullable = nullable ?? dec.name !== 'OneToOne';
  if (!out.columns.some((c) => c.name.toLowerCase() === fkName.toLowerCase())) {
    out.columns.push(column(fkName, '', { nullable: colNullable, source: src }));
  }
  out.relations.push({
    from: { model: entity.model, name: entity.name },
    fromColumns: [fkName],
    to: { model: target },
    toColumns: refCol ? [refCol] : [],
    cardinality: dec.name === 'OneToOne' ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    optional: colNullable,
    source: src,
  });
}

/** Class-level `@Index` / `@Unique`. */
function classIndexes(code: Code, decorators: readonly Decorator[], propToColumn: Map<string, string>): RawEntity['indexes'] {
  const out: NonNullable<RawEntity['indexes']> = [];
  for (const d of decorators) {
    if (d.name !== 'Index' && d.name !== 'Unique') continue;
    if (d.open < 0) continue;
    const args = code.args(d.open);
    let name: string | undefined;
    let columns: string[] = [];
    let unique = d.name === 'Unique';
    for (const p of args.positional) {
      if (p.text.startsWith('[')) {
        columns = code.items(p.start).map((it) => stringValue(it.text) ?? it.text).filter(Boolean);
      } else if (p.text.startsWith('{')) {
        const obj = code.object(p.start);
        if (boolValue(obj.get('unique')?.text)) unique = true;
      } else {
        const s = stringValue(p.text);
        if (s) name = s;
      }
    }
    if (!columns.length) continue;
    out.push({ name, unique, columns: columns.map((c) => propToColumn.get(c) ?? c), source: { file: '', line: d.line } });
  }
  return out.length ? out : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// EntitySchema({ … })
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseEntitySchemas(code: Code, file: SourceFile, result: ParseResult): void {
  const m = code.masked;
  const re = /\bnew\s+EntitySchema\s*\(|\bEntitySchema\s*</g;
  for (const match of m.matchAll(re)) {
    const open = m.indexOf('(', match.index + match[0].length - 1);
    if (open < 0) continue;
    const args = code.args(open);
    const objSpan = args.positional.find((p) => p.text.startsWith('{'));
    if (!objSpan) continue;
    const obj = code.object(objSpan.start);
    const modelName = (obj.get('name') && stringValue(obj.get('name')!.text)) || undefined;
    const tableNameSpan = obj.get('tableName');
    const tableName = tableNameSpan && stringValue(tableNameSpan.text);
    const name = tableName || (modelName ? defaultTableName(KIND, modelName) : undefined);
    if (!name) continue;
    const line = code.lineAt(match.index);
    const columns: Column[] = [];
    const colsSpan = obj.get('columns');
    if (colsSpan?.text.startsWith('{')) {
      for (const field of code.object(colsSpan.start)) {
        const [prop, span] = field;
        if (!span.text.startsWith('{')) continue;
        const def = code.object(span.start);
        let colName = prop;
        const cn = def.get('name') && stringValue(def.get('name')!.text);
        if (cn) colName = cn;
        const type = esType(def.get('type')?.text);
        const primary = boolValue(def.get('primary')?.text) === true;
        columns.push(
          column(colName, type, {
            primaryKey: primary,
            nullable: primary ? false : boolValue(def.get('nullable')?.text) ?? false,
            unique: boolValue(def.get('unique')?.text) === true,
            generated: boolValue(def.get('generated')?.text) === true || undefined,
            source: { file: file.path, line },
          }),
        );
      }
    }
    const schemaName = obj.get('schema') && stringValue(obj.get('schema')!.text);
    result.entities.push({
      name,
      ...(schemaName ? { schema: schemaName } : {}),
      kind: 'table',
      modelName,
      nameCertainty: tableName ? 2 : 0,
      columns,
      source: { file: file.path, line },
    });
    // relations
    const relSpan = obj.get('relations');
    if (relSpan?.text.startsWith('{')) {
      for (const field of code.object(relSpan.start)) {
        const [, span] = field;
        if (!span.text.startsWith('{')) continue;
        const def = code.object(span.start);
        const target = targetModel(def.get('target')?.text);
        const relType = stringValue(def.get('type')?.text);
        if (!target || !relType) continue;
        const card = relType === 'many-to-one' || relType === 'one-to-one' || relType === 'many-to-many' || relType === 'one-to-many' ? relType : 'many-to-one';
        result.relations.push({
          from: { model: modelName, name },
          fromColumns: [],
          to: { model: target },
          toColumns: [],
          cardinality: card,
          kind: 'orm',
          source: { file: file.path, line },
        });
      }
    }
  }
}

function esType(text: string | undefined): string {
  if (!text) return '';
  const s = stringValue(text);
  if (s) return s;
  // Native type constructors: String, Number, Boolean, Date…
  const id = /^([A-Za-z_$][\w$]*)/.exec(text.trim());
  if (!id) return '';
  const map: Record<string, string> = { String: 'varchar', Number: 'int', Boolean: 'boolean', Date: 'timestamp' };
  return map[id[1]] ?? id[1];
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'js');
  const result: ParseResult = { entities: [], relations: [], enums: [] };
  const classes = findClasses(code);

  for (const cls of classes) {
    const info = entityInfo(code, cls);
    const isChild = findDecorator(cls.decorators, 'ChildEntity');
    const classMembers = members(code, cls.bodyOpen, cls.bodyClose, { decorators: true });
    const hasColumnDecorator = classMembers.some((mem) => findDecorator(mem.decorators, ...COLUMN_DECORATORS, ...RELATION_DECORATORS));
    if (!info && !cls.abstract && !hasColumnDecorator) continue;

    const entityName = info ? info.name : defaultTableName(KIND, cls.name);
    const abstract = !info; // no @Entity → treat as abstract base / mapped superclass
    const columns: Column[] = [];
    const relations: RawRelation[] = [];
    const propToColumn = new Map<string, string>();
    const enums: RawEnum[] = [];

    for (const mem of classMembers) {
      const relDec = findDecorator(mem.decorators, ...RELATION_DECORATORS);
      if (relDec) {
        parseRelation(code, file, mem, relDec, { name: entityName, model: cls.name }, { relations, columns });
        continue;
      }
      const colDec = findDecorator(mem.decorators, ...COLUMN_DECORATORS);
      if (!colDec) continue;
      const { col, enumValues } = buildColumn(code, file, mem, colDec, entityName);
      if (findDecorator(mem.decorators, 'Unique')) col.unique = true;
      const idxDec = findDecorator(mem.decorators, 'Index');
      if (idxDec) {
        const opt = optionsOf(code, idxDec.open);
        if (boolValue(opt?.get('unique')?.text)) col.unique = true;
      }
      propToColumn.set(mem.name, col.name);
      columns.push(col);
      if (enumValues) enums.push({ name: col.enumRef!, values: enumValues, source: { file: file.path, line: mem.line } });
    }

    if (!columns.length && !relations.length && !info) continue;

    const indexes = (classIndexes(code, cls.decorators, propToColumn) ?? []).map((ix) => ({ ...ix, source: { file: file.path, line: ix.source?.line ?? cls.line } }));
    const entity: RawEntity = {
      name: entityName,
      kind: info?.kind ?? 'table',
      modelName: cls.name,
      nameCertainty: info?.certainty ?? 0,
      columns,
      source: { file: file.path, line: cls.line },
    };
    if (info?.schema) entity.schema = info.schema;
    if (indexes.length) entity.indexes = indexes;
    if (abstract) entity.abstract = true;
    if (cls.extendsName) entity.extends = [cls.extendsName];
    if (isChild) {
      entity.sharedTable = true;
      entity.nameCertainty = 0;
    }
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

export const typeormParser: SchemaParser = { kind: KIND, extensions: EXTENSIONS, detect, parse };
