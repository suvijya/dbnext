/**
 * Peewee parser (definitions).
 *
 * `class User(Model | BaseModel)` with `CharField`, `IntegerField`, `ForeignKeyField(User|'self')`
 * (→ a `<name>_id` column + many-to-one) and `ManyToManyField(Tag, through_model=…)`. An implicit
 * `id` AutoField primary key is added unless a field declares `primary_key=True`. `class Meta`
 * provides `table_name` and `schema`. Base classes that only carry a `Meta` are abstract.
 */

import type { Column, EntityRef, IndexDef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName } from '../core/naming';
import { Code, boolValue, stringValue } from '../core/text';
import {
  bracketAt,
  classMembers,
  docstring,
  findClasses,
  namedBool,
  namedString,
  namedText,
  nestedClass,
  type PyClass,
  type PyMember,
  positionalText,
  quotedList,
  tail,
  typeName,
} from './shared/python';

const ON_DELETE: Readonly<Record<string, string>> = {
  CASCADE: 'CASCADE',
  'SET NULL': 'SET NULL',
  SET_NULL: 'SET NULL',
  'SET DEFAULT': 'SET DEFAULT',
  RESTRICT: 'RESTRICT',
  'NO ACTION': 'NO ACTION',
};

export const peeweeParser: SchemaParser = {
  kind: 'peewee',
  extensions: ['.py'],
  detect(file: SourceFile): boolean {
    const t = file.text;
    if (!/\bpeewee\b/.test(t)) return false;
    return /from\s+peewee\b|import\s+peewee\b/.test(t) && /[A-Za-z_]\w*Field\s*\(/.test(t);
  },
  parse(file: SourceFile): ParseResult {
    const res = emptyResult('definition');
    const code = new Code(file.text, 'python');
    const classes = findClasses(code);
    const byName = new Map<string, PyClass>();
    for (const c of classes) byName.set(c.name, c);

    const reachesModel = (c: PyClass, seen = new Set<string>()): boolean => {
      for (const b of c.baseNames) {
        if (b === 'Model') return true;
        const bc = byName.get(b);
        if (bc && !seen.has(b)) {
          seen.add(b);
          if (reachesModel(bc, seen)) return true;
        }
      }
      return false;
    };
    const modelNames = new Set<string>();
    for (const c of classes) if (c.name !== 'Meta' && reachesModel(c)) modelNames.add(c.name);

    for (const c of classes) {
      if (!modelNames.has(c.name)) continue;
      emitModel(code, classes, file, c, modelNames, res);
    }
    return res;
  },
};

function fieldKind(mem: PyMember): 'fk' | 'm2m' | 'field' | undefined {
  const b = mem.callBase;
  if (!b) return undefined;
  if (b === 'ForeignKeyField' || b === 'DeferredForeignKey') return 'fk';
  if (b === 'ManyToManyField') return 'm2m';
  if (/Field$/.test(b)) return 'field';
  return undefined;
}

function emitModel(code: Code, classes: readonly PyClass[], file: SourceFile, c: PyClass, modelNames: Set<string>, res: ParseResult): void {
  const members = classMembers(code, c);
  const columns: Column[] = [];
  let hasExplicitPk = false;
  let fieldCount = 0;

  for (const mem of members) {
    const kind = fieldKind(mem);
    if (!kind || mem.callOpen === undefined) continue;
    fieldCount++;
    const args = code.args(mem.callOpen);
    const nullable = namedBool(args, 'null') === true;
    const columnName = namedString(args, 'column_name');

    if (kind === 'm2m') {
      res.relations.push(m2mRelation(file, c.name, args, mem.line));
      continue;
    }
    if (kind === 'fk') {
      const colName = columnName ?? `${mem.name}_id`;
      const primary = namedBool(args, 'primary_key') === true;
      if (primary) hasExplicitPk = true;
      const unique = namedBool(args, 'unique') === true;
      columns.push(column(colName, '', { nullable: nullable && !primary, primaryKey: primary, unique, source: sourceRef(file, mem.line) }));
      res.relations.push(fkRelation(file, c.name, colName, args, nullable, unique, mem.line));
      continue;
    }

    const primary = namedBool(args, 'primary_key') === true;
    if (primary || mem.callBase === 'AutoField' || mem.callBase === 'BigAutoField') hasExplicitPk = true;
    const col = column(columnName ?? mem.name, typeName(mem.callBase), {
      nullable: nullable && !primary,
      primaryKey: primary,
      unique: namedBool(args, 'unique') === true,
      source: sourceRef(file, mem.line),
    });
    const def = namedText(args, 'default');
    if (def !== undefined) col.default = def;
    columns.push(col);
  }

  const meta = parseMeta(code, classes, c);
  const abstract = fieldCount === 0;

  if (!abstract && !hasExplicitPk && !columns.some((x) => x.name === 'id')) {
    columns.unshift(column('id', 'AutoField', { nullable: false, primaryKey: true, generated: true }));
  }

  const name = meta.tableName ?? defaultTableName('peewee', c.name);
  const entity: RawEntity = {
    name,
    kind: 'table',
    modelName: c.name,
    nameCertainty: meta.tableName ? 2 : 0,
    columns,
    source: sourceRef(file, c.line),
  };
  if (meta.schema) entity.schema = meta.schema;
  if (abstract) entity.abstract = true;
  const extendsBases = c.baseNames.filter((b) => b !== 'Model' && modelNames.has(b));
  if (extendsBases.length) entity.extends = extendsBases;
  if (meta.indexes.length) entity.indexes = meta.indexes;
  const comment = docstring(code, c);
  if (comment) entity.comment = comment;
  res.entities.push(entity);
}

function fkRelation(file: SourceFile, model: string, colName: string, args: ReturnType<Code['args']>, nullable: boolean, unique: boolean, line: number): RawRelation {
  const targetExpr = positionalText(args, 0) ?? namedText(args, 'model');
  const target = fkTarget(targetExpr, model);
  const field = namedString(args, 'field');
  const rel: RawRelation = {
    from: { model },
    fromColumns: [colName],
    to: target,
    toColumns: field ? [field] : [],
    cardinality: unique ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: sourceRef(file, line),
  };
  const onDelete = namedString(args, 'on_delete');
  if (onDelete) rel.onDelete = ON_DELETE[onDelete.toUpperCase()] ?? onDelete.toUpperCase();
  return rel;
}

function m2mRelation(file: SourceFile, model: string, args: ReturnType<Code['args']>, line: number): RawRelation {
  const target = fkTarget(positionalText(args, 0) ?? namedText(args, 'model'), model);
  const through = namedText(args, 'through_model');
  const rel: RawRelation = {
    from: { model },
    fromColumns: [],
    to: target,
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    source: sourceRef(file, line),
  };
  if (through) rel.through = { model: tail(stringValue(through) ?? through) };
  return rel;
}

function fkTarget(raw: string | undefined, current: string): EntityRef {
  if (!raw) return { model: current };
  const val = stringValue(raw) ?? raw.trim();
  if (val === 'self') return { model: current };
  return { model: tail(val) };
}

interface Meta {
  tableName?: string;
  schema?: string;
  indexes: IndexDef[];
}

function parseMeta(code: Code, classes: readonly PyClass[], c: PyClass): Meta {
  const meta: Meta = { indexes: [] };
  const metaClass = nestedClass(code, classes, c, 'Meta');
  if (!metaClass) return meta;
  for (const mem of classMembers(code, metaClass)) {
    if (mem.name === 'table_name' || mem.name === 'db_table') meta.tableName = stringValue(mem.valueText ?? '');
    else if (mem.name === 'schema') meta.schema = stringValue(mem.valueText ?? '');
    else if (mem.name === 'indexes' && mem.valueStart !== undefined) {
      const open = bracketAt(code, mem.valueStart, mem.end);
      if (open < 0) continue;
      for (const item of code.items(open)) {
        // ((('field1', 'field2'), True)) → tuple of (columns, unique)
        const inner = bracketAt(code, item.start, item.end);
        if (inner < 0) continue;
        const parts = code.items(inner);
        const cols = quotedList(parts[0]?.text ?? '');
        const unique = boolValue(parts[1]?.text ?? '') === true;
        if (cols.length) meta.indexes.push({ columns: cols, unique });
      }
    }
  }
  return meta;
}
