/**
 * Tortoise ORM parser (definitions).
 *
 * `class Tournament(Model)` with `fields.IntField(pk=True)`, `fields.CharField(max_length, null,
 * unique, source_field)`, `fields.ForeignKeyField('models.Team', …)` (→ a `<name>_id` column +
 * many-to-one), `fields.OneToOneField` and `fields.ManyToManyField(…, through='event_team')`.
 * An implicit `id` IntField primary key is added unless a field sets `pk=True`. `class Meta`
 * provides `table` and `abstract`.
 */

import type { Column, EntityRef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName } from '../core/naming';
import { Code, boolValue, stringValue } from '../core/text';
import {
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
  tail,
  typeName,
} from './shared/python';

const ON_DELETE: Readonly<Record<string, string>> = {
  CASCADE: 'CASCADE',
  SET_NULL: 'SET NULL',
  'SET NULL': 'SET NULL',
  SET_DEFAULT: 'SET DEFAULT',
  RESTRICT: 'RESTRICT',
  'NO ACTION': 'NO ACTION',
};

export const tortoiseParser: SchemaParser = {
  kind: 'tortoise',
  extensions: ['.py'],
  detect(file: SourceFile): boolean {
    const t = file.text;
    return /\btortoise\b/.test(t) && /fields\.\w+\s*\(|from\s+tortoise(?:\.models)?\s+import/.test(t);
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

function fieldKind(mem: PyMember): 'fk' | 'o2o' | 'm2m' | 'field' | undefined {
  const b = mem.callBase;
  if (!b) return undefined;
  if (b === 'ForeignKeyField' || b === 'ForeignKeyRelation') return 'fk';
  if (b === 'OneToOneField' || b === 'OneToOneRelation') return 'o2o';
  if (b === 'ManyToManyField' || b === 'ManyToManyRelation') return 'm2m';
  if (/Field$/.test(b)) return 'field';
  return undefined;
}

function emitModel(code: Code, classes: readonly PyClass[], file: SourceFile, c: PyClass, modelNames: Set<string>, res: ParseResult): void {
  const members = classMembers(code, c);
  const columns: Column[] = [];
  let hasExplicitPk = false;

  for (const mem of members) {
    const kind = fieldKind(mem);
    if (!kind || mem.callOpen === undefined) continue;
    const args = code.args(mem.callOpen);
    const nullable = namedBool(args, 'null') === true;
    const sourceField = namedString(args, 'source_field');

    if (kind === 'm2m') {
      res.relations.push(m2mRelation(file, c.name, args, mem.line));
      continue;
    }
    if (kind === 'fk' || kind === 'o2o') {
      const colName = sourceField ?? `${mem.name}_id`;
      const primary = namedBool(args, 'pk') === true || namedBool(args, 'primary_key') === true;
      if (primary) hasExplicitPk = true;
      columns.push(
        column(colName, '', {
          nullable: nullable && !primary,
          primaryKey: primary,
          unique: kind === 'o2o' || namedBool(args, 'unique') === true,
          source: sourceRef(file, mem.line),
        }),
      );
      res.relations.push(fkRelation(file, c.name, colName, kind, args, nullable, mem.line));
      continue;
    }

    const primary = namedBool(args, 'pk') === true || namedBool(args, 'primary_key') === true;
    if (primary) hasExplicitPk = true;
    const col = column(sourceField ?? mem.name, typeName(mem.callBase), {
      nullable: nullable && !primary,
      primaryKey: primary,
      unique: namedBool(args, 'unique') === true,
      source: sourceRef(file, mem.line),
    });
    if (primary) col.generated = mem.callBase === 'IntField' || mem.callBase === 'BigIntField';
    const def = namedText(args, 'default');
    if (def !== undefined) col.default = def;
    columns.push(col);
  }

  const meta = parseMeta(code, classes, c);

  if (!meta.abstract && !hasExplicitPk && !columns.some((x) => x.name === 'id')) {
    columns.unshift(column('id', 'IntField', { nullable: false, primaryKey: true, generated: true }));
  }

  const name = meta.table ?? defaultTableName('tortoise', c.name);
  const entity: RawEntity = {
    name,
    kind: 'table',
    modelName: c.name,
    nameCertainty: meta.table ? 2 : 0,
    columns,
    source: sourceRef(file, c.line),
  };
  if (meta.abstract) entity.abstract = true;
  const extendsBases = c.baseNames.filter((b) => b !== 'Model' && modelNames.has(b));
  if (extendsBases.length) entity.extends = extendsBases;
  const comment = docstring(code, c);
  if (comment) entity.comment = comment;
  res.entities.push(entity);
}

function fkRelation(file: SourceFile, model: string, colName: string, kind: 'fk' | 'o2o', args: ReturnType<Code['args']>, nullable: boolean, line: number): RawRelation {
  const target = fkTarget(positionalText(args, 0) ?? namedText(args, 'model_name'));
  const rel: RawRelation = {
    from: { model },
    fromColumns: [colName],
    to: target,
    toColumns: [],
    cardinality: kind === 'o2o' ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: sourceRef(file, line),
  };
  const onDelete = namedText(args, 'on_delete');
  if (onDelete) {
    const token = tail(onDelete).toUpperCase();
    rel.onDelete = ON_DELETE[token] ?? token;
  }
  return rel;
}

function m2mRelation(file: SourceFile, model: string, args: ReturnType<Code['args']>, line: number): RawRelation {
  const target = fkTarget(positionalText(args, 0) ?? namedText(args, 'model_name'));
  const through = namedString(args, 'through');
  const rel: RawRelation = {
    from: { model },
    fromColumns: [],
    to: target,
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    source: sourceRef(file, line),
  };
  if (through) rel.through = { name: through };
  return rel;
}

/** `'models.Team'` → `{ model: 'Team' }`. */
function fkTarget(raw: string | undefined): EntityRef {
  const val = raw ? (stringValue(raw) ?? raw.trim()) : '';
  return { model: tail(val) || 'Model' };
}

interface Meta {
  table?: string;
  abstract: boolean;
}

function parseMeta(code: Code, classes: readonly PyClass[], c: PyClass): Meta {
  const meta: Meta = { abstract: false };
  const metaClass = nestedClass(code, classes, c, 'Meta');
  if (!metaClass) return meta;
  for (const mem of classMembers(code, metaClass)) {
    if (mem.name === 'table') meta.table = stringValue(mem.valueText ?? '');
    else if (mem.name === 'abstract') meta.abstract = boolValue(mem.valueText ?? '') === true;
  }
  return meta;
}
