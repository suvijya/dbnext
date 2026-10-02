/**
 * Ent (Go) schema parser — `entgo.io/ent`.
 *
 * Two complementary sources:
 *  - `ent/schema/*.go`: hand-written `type X struct { ent.Schema }` with `Fields()`, `Edges()`,
 *    `Annotations()`, `Indexes()` and `Mixin()`. The table name follows `pluralize(snake(Type))`
 *    unless an `entsql.Annotation{Table: …}` sets it. An implicit `id` int PK is added.
 *  - `ent/migrate/schema.go`: the generated `XxxColumns` / `XxxTable` tables with explicit columns,
 *    primary keys and foreign keys — the most reliable source (certainty 2).
 */

import {
  type Column,
  type IndexDef,
  type ParseResult,
  type RawEntity,
  type RawEnum,
  type RawRelation,
  type SourceFile,
} from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, shortName, singularize, snakeCase } from '../core/naming';
import { boolValue, Code, cleanComment, numberValue, stringValue } from '../core/text';
import { goMethods, goStructFields, goStructs } from './shared/gorust';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ent/schema/*.go
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STR_LIT = /"(?:[^"\\]|\\.)*"/g;

function entFieldType(method: string): string {
  switch (method) {
    case 'String':
    case 'Text':
      return 'string';
    case 'Bool':
      return 'bool';
    case 'Time':
      return 'time.Time';
    case 'UUID':
      return 'uuid.UUID';
    case 'JSON':
      return 'json';
    case 'Bytes':
      return '[]byte';
    case 'Float':
      return 'float64';
    case 'Int':
      return 'int';
    default:
      return method.toLowerCase();
  }
}

interface EntField {
  column: Column;
  enum?: RawEnum;
}

const FIELD_BASE_RE = /field\s*\.\s*(\w+)\s*\(\s*("(?:[^"\\]|\\.)*")/;

function parseEntField(file: string, table: string, text: string, line: number): EntField | undefined {
  const base = FIELD_BASE_RE.exec(text);
  if (!base) return undefined;
  const method = base[1];
  const fieldName = stringValue(base[2]);
  if (!fieldName) return undefined;

  const storage = /\.StorageKey\s*\(\s*("(?:[^"\\]|\\.)*")/.exec(text);
  const comment = /\.Comment\s*\(\s*("(?:[^"\\]|\\.)*")/.exec(text);
  const name = (storage && stringValue(storage[1])) || fieldName;

  // Ent fields are NOT NULL unless `.Optional()`; `.Nillable()` only affects the Go pointer type.
  const props: Partial<Column> = { nullable: /\.Optional\s*\(/.test(text), unique: /\.Unique\s*\(/.test(text), source: { file, line } };
  if (/\.(?:Default|DefaultFunc|UpdateDefault)\s*\(/.test(text)) props.generated = true;
  if (comment) {
    const c = stringValue(comment[1]);
    if (c) props.comment = c;
  }

  if (method === 'Enum') {
    const enumName = `${table}_${snakeCase(fieldName)}`;
    const valuesCall = /\.Values\s*\(([\s\S]*?)\)/.exec(text);
    const values = valuesCall ? [...valuesCall[1].matchAll(STR_LIT)].map((m) => stringValue(m[0]) ?? '').filter(Boolean) : [];
    const col = column(name, enumName, props);
    col.enumRef = enumName;
    return { column: col, enum: { name: enumName, values, source: { file, line } } };
  }
  return { column: column(name, entFieldType(method), props) };
}

const EDGE_BASE_RE = /edge\s*\.\s*(To|From)\s*\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(\w+)\s*\.\s*Type/;

interface EntEdge {
  relation: RawRelation;
  /** Foreign-key column to add to the current (FK-holding) entity, when known. */
  column?: Column;
}

function parseEntEdge(file: string, thisType: string, text: string, line: number): EntEdge | undefined {
  const base = EDGE_BASE_RE.exec(text);
  if (!base) return undefined;
  const dir = base[1];
  const edgeName = stringValue(base[2]);
  const target = base[3];
  if (!edgeName) return undefined;
  const unique = /\.Unique\s*\(/.test(text);
  const required = /\.Required\s*\(/.test(text);
  const src = sourceRef(file, line);

  if (dir === 'To') {
    const fkCol = `${snakeCase(thisType)}_${snakeCase(edgeName)}`;
    if (unique) {
      // O2O: the FK lives on the target table.
      return { relation: { from: { model: target }, fromColumns: [fkCol], to: { model: thisType }, toColumns: [], cardinality: 'one-to-one', kind: 'orm', source: src } };
    }
    return { relation: { from: { model: thisType }, fromColumns: [], to: { model: target }, toColumns: [fkCol], cardinality: 'one-to-many', kind: 'orm', source: src } };
  }

  // edge.From(...).Ref(...): inverse edge; the FK lives on THIS entity.
  const refMatch = /\.Ref\s*\(\s*("(?:[^"\\]|\\.)*")/.exec(text);
  const fieldMatch = /\.Field\s*\(\s*("(?:[^"\\]|\\.)*")/.exec(text);
  const ref = refMatch ? stringValue(refMatch[1]) : undefined;
  const fkCol = (fieldMatch && stringValue(fieldMatch[1])) || `${snakeCase(target)}_${snakeCase(ref ?? edgeName)}`;
  if (unique) {
    const col = column(fkCol, '', { nullable: !required, source: src });
    return { relation: { from: { model: thisType }, fromColumns: [fkCol], to: { model: target }, toColumns: [], cardinality: 'many-to-one', kind: 'orm', source: src }, column: col };
  }
  // Both sides non-unique → many-to-many.
  return { relation: { from: { model: thisType }, fromColumns: [], to: { model: target }, toColumns: [], cardinality: 'many-to-many', kind: 'orm', source: src } };
}

function sliceBrace(code: Code, start: number, end: number, re: RegExp): number {
  const m = re.exec(code.masked.slice(start, end));
  return m ? start + m.index + m[0].length - 1 : -1;
}

function parseSchemaFiles(code: Code, file: SourceFile): ParseResult {
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const enums: RawEnum[] = [];
  const methods = goMethods(code);
  const methodOf = (recv: string, name: string) => methods.find((m) => m.recv === recv && m.name === name);

  for (const struct of goStructs(code)) {
    const fields = goStructFields(code, struct.open);
    const embeds = (t: string) => fields.some((f) => f.embedded && f.type === t);
    const concrete = embeds('ent.Schema');
    const mixin = embeds('mixin.Schema');
    if (!concrete && !mixin) continue;

    // Table name (annotation beats convention).
    let name = defaultTableName('ent', struct.name);
    let certainty: 0 | 2 = 0;
    const anno = methodOf(struct.name, 'Annotations');
    if (anno) {
      const m = /Table\s*:\s*("(?:[^"\\]|\\.)*")/.exec(code.stripped.slice(anno.open, anno.close));
      const t = m ? stringValue(m[1]) : undefined;
      if (t) {
        name = t;
        certainty = 2;
      }
    }

    // Fields.
    const columns: Column[] = [];
    const fieldsMethod = methodOf(struct.name, 'Fields');
    if (fieldsMethod) {
      const brace = sliceBrace(code, fieldsMethod.open, fieldsMethod.close, /\[\]ent\.Field\s*\{/);
      if (brace >= 0) {
        for (const item of code.items(brace)) {
          const parsed = parseEntField(file.path, name, item.text, code.lineAt(item.start));
          if (!parsed) continue;
          if (!columns.some((c) => c.name === parsed.column.name)) columns.push(parsed.column);
          if (parsed.enum) enums.push(parsed.enum);
        }
      }
    }

    // Edges.
    const edgesMethod = methodOf(struct.name, 'Edges');
    if (edgesMethod) {
      const brace = sliceBrace(code, edgesMethod.open, edgesMethod.close, /\[\]ent\.Edge\s*\{/);
      if (brace >= 0) {
        for (const item of code.items(brace)) {
          const edge = parseEntEdge(file.path, struct.name, item.text, code.lineAt(item.start));
          if (!edge) continue;
          relations.push(edge.relation);
          if (edge.column && !columns.some((c) => c.name === edge.column!.name)) columns.push(edge.column);
        }
      }
    }

    // Mixin → extends.
    const extendsList: string[] = [];
    const mixinMethod = methodOf(struct.name, 'Mixin');
    if (mixinMethod) {
      for (const m of code.masked.slice(mixinMethod.open, mixinMethod.close).matchAll(/(\w+)\s*\{\s*\}/g)) {
        extendsList.push(shortName(m[1]));
      }
    }

    // Indexes.
    const indexes: IndexDef[] = [];
    const indexMethod = methodOf(struct.name, 'Indexes');
    if (indexMethod) {
      for (const call of code.stripped.slice(indexMethod.open, indexMethod.close).matchAll(/index\s*\.\s*Fields\s*\(([\s\S]*?)\)([\s\S]*?)(?=index\s*\.|$)/g)) {
        const cols = [...call[1].matchAll(STR_LIT)].map((x) => stringValue(x[0]) ?? '').filter(Boolean);
        if (cols.length) indexes.push({ columns: cols, unique: /\.Unique\s*\(/.test(call[2]) });
      }
    }

    if (concrete && !columns.some((c) => c.name === 'id')) {
      columns.unshift(column('id', 'int', { primaryKey: true, nullable: false, generated: true, source: sourceRef(file, struct.line) }));
    } else {
      const id = columns.find((c) => c.name === 'id');
      if (id) {
        id.primaryKey = true;
        id.nullable = false;
      }
    }

    const entity: RawEntity = {
      name: mixin ? defaultTableName('ent', struct.name) : name,
      kind: 'table',
      modelName: struct.name,
      nameCertainty: mixin ? 0 : certainty,
      columns,
      source: sourceRef(file, struct.line),
    };
    if (mixin) entity.abstract = true;
    if (extendsList.length) entity.extends = extendsList;
    if (indexes.length) entity.indexes = indexes;
    const comment = cleanComment(code.leadingComments(code.lineStart(struct.line)).join('\n'));
    if (comment) entity.comment = comment;
    entities.push(entity);
  }

  return { entities, relations, enums };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ent/migrate/schema.go
// ─────────────────────────────────────────────────────────────────────────────────────────────

const COLUMN_TYPE_PREFIX = /^field\.Type/;

function entColumnType(expr: string | undefined): string {
  if (!expr) return '';
  const t = expr.trim().replace(COLUMN_TYPE_PREFIX, '');
  switch (t) {
    case 'String':
      return 'string';
    case 'Bool':
      return 'bool';
    case 'Time':
      return 'time.Time';
    case 'UUID':
      return 'uuid.UUID';
    case 'JSON':
      return 'json';
    case 'Bytes':
      return '[]byte';
    case 'Enum':
      return 'enum';
    default:
      return t ? t.toLowerCase() : '';
  }
}

function mapOnAction(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const t = expr.trim().replace(/^schema\./, '');
  switch (t) {
    case 'SetNull':
      return 'SET NULL';
    case 'Cascade':
      return 'CASCADE';
    case 'Restrict':
      return 'RESTRICT';
    case 'NoAction':
      return 'NO ACTION';
    case 'SetDefault':
      return 'SET DEFAULT';
    default:
      return undefined;
  }
}

const COL_REF_RE = /(\w+Columns)\s*\[\s*(\d+)\s*\]/g;

function resolveColRefs(text: string, columnsByVar: Map<string, Column[]>): { vars: Set<string>; names: string[] } {
  const vars = new Set<string>();
  const names: string[] = [];
  for (const m of text.matchAll(COL_REF_RE)) {
    const list = columnsByVar.get(m[1]);
    vars.add(m[1]);
    const col = list?.[Number(m[2])];
    if (col) names.push(col.name);
  }
  return { vars, names };
}

interface MigrateTable {
  tableVar: string;
  name: string;
  columnsVar: string;
  columns: Column[];
  foreignKeysBrace: number;
}

function parseMigrateSchema(code: Code, file: SourceFile): ParseResult {
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const masked = code.masked;

  // 1. Column variable definitions.
  const columnsByVar = new Map<string, Column[]>();
  for (const m of masked.matchAll(/(\w+Columns)\s*=\s*\[\]\*schema\.Column\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    const cols: Column[] = [];
    for (const item of code.items(brace)) {
      if (masked[item.start] !== '{') continue;
      const obj = code.object(item.start);
      const nameSpan = obj.get('Name');
      const name = nameSpan ? stringValue(nameSpan.text) : undefined;
      if (!name) continue;
      const props: Partial<Column> = {
        nullable: boolValue(obj.get('Nullable')?.text) ?? false,
        unique: boolValue(obj.get('Unique')?.text) ?? false,
        source: sourceRef(file, code.lineAt(item.start)),
      };
      if (boolValue(obj.get('Increment')?.text)) props.generated = true;
      const def = obj.get('Default');
      if (def) props.default = def.text;
      const size = numberValue(obj.get('Size')?.text);
      const type = entColumnType(obj.get('Type')?.text);
      cols.push(column(name, type === 'string' && size ? `varchar(${size})` : type, props));
    }
    columnsByVar.set(m[1], cols);
  }

  // 2. Table variable definitions.
  const tables: MigrateTable[] = [];
  const tableByColumnsVar = new Map<string, MigrateTable>();
  for (const m of masked.matchAll(/(\w+)Table\s*=\s*&schema\.Table\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    const obj = code.object(brace);
    const nameSpan = obj.get('Name');
    const name = nameSpan ? stringValue(nameSpan.text) : undefined;
    const columnsVar = obj.get('Columns')?.text.trim();
    if (!name || !columnsVar) continue;
    const columns = (columnsByVar.get(columnsVar) ?? []).map((c) => ({ ...c }));
    const pk = obj.get('PrimaryKey');
    if (pk) {
      for (const colName of resolveColRefs(pk.text, columnsByVar).names) {
        const col = columns.find((c) => c.name === colName);
        if (col) {
          col.primaryKey = true;
          col.nullable = false;
        }
      }
    }
    const fkSpan = obj.get('ForeignKeys');
    const fkBrace = fkSpan ? code.masked.indexOf('{', fkSpan.start) : -1;
    const table: MigrateTable = { tableVar: `${m[1]}Table`, name, columnsVar, columns, foreignKeysBrace: fkBrace >= 0 && fkBrace < (fkSpan?.end ?? -1) ? fkBrace : -1 };
    tables.push(table);
    tableByColumnsVar.set(columnsVar, table);

    const entity: RawEntity = {
      name,
      kind: 'table',
      modelName: singularize(m[1]),
      nameCertainty: 2,
      columns,
      source: sourceRef(file, code.lineAt(m.index)),
    };
    entities.push(entity);
  }

  // 3. Foreign keys → relations (target table inferred from the RefColumns variable).
  for (const table of tables) {
    if (table.foreignKeysBrace < 0) continue;
    for (const item of code.items(table.foreignKeysBrace)) {
      if (code.masked[item.start] !== '{') continue;
      const obj = code.object(item.start);
      const colsSpan = obj.get('Columns');
      const refSpan = obj.get('RefColumns');
      if (!colsSpan || !refSpan) continue;
      const fromCols = resolveColRefs(colsSpan.text, columnsByVar).names;
      const refInfo = resolveColRefs(refSpan.text, columnsByVar);
      const refVar = [...refInfo.vars][0];
      const target = refVar ? tableByColumnsVar.get(refVar) : undefined;
      if (!fromCols.length || !target) continue;
      const unique = fromCols.every((name) => table.columns.find((c) => c.name === name)?.unique);
      const rel: RawRelation = {
        from: { name: table.name },
        fromColumns: fromCols,
        to: { name: target.name },
        toColumns: refInfo.names,
        cardinality: unique ? 'one-to-one' : 'many-to-one',
        kind: 'foreign-key',
        source: sourceRef(file, code.lineAt(item.start)),
      };
      const onDelete = mapOnAction(obj.get('OnDelete')?.text);
      const onUpdate = mapOnAction(obj.get('OnUpdate')?.text);
      if (onDelete) rel.onDelete = onDelete;
      if (onUpdate) rel.onUpdate = onUpdate;
      relations.push(rel);
    }
  }

  return { entities, relations, enums: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detect(file: SourceFile): boolean {
  return file.text.includes('entgo.io/ent');
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'go');
  if (file.text.includes('schema.Table{') && file.text.includes('[]*schema.Column{')) {
    return parseMigrateSchema(code, file);
  }
  return parseSchemaFiles(code, file);
}

export const entParser: SchemaParser = {
  kind: 'ent',
  extensions: ['.go'],
  detect,
  parse,
};
