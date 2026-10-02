/**
 * SQLModel parser (definitions).
 *
 * `class Hero(SQLModel, table=True)` becomes a table; its annotated fields become columns.
 * `Field(primary_key=True, foreign_key="team.id", index=True, unique=…)` is honoured, `| None` /
 * `Optional[…]` mean nullable, `Relationship(...)` fields are navigation (not columns, but
 * `link_model=` yields a many-to-many). Classes that subclass SQLModel without `table=True` are
 * data/base models, emitted as abstract so `class Hero(HeroBase, table=True)` inherits their fields.
 */

import type { Column, EntityRef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { Code, boolValue, stringValue } from '../core/text';
import {
  classMembers,
  docstring,
  findClasses,
  namedBool,
  namedString,
  namedText,
  type PyClass,
  type PyMember,
  tail,
  unwrapOptional,
} from './shared/python';

const WRAPPERS = new Set(['list', 'List', 'set', 'Set', 'Sequence', 'Optional', 'Mapped', 'Union', 'dict', 'Dict', 'None']);

export const sqlmodelParser: SchemaParser = {
  kind: 'sqlmodel',
  extensions: ['.py'],
  detect(file: SourceFile): boolean {
    const t = file.text;
    return /\bsqlmodel\b/.test(t) && /\bSQLModel\b/.test(t);
  },
  parse(file: SourceFile): ParseResult {
    const res = emptyResult('definition');
    const code = new Code(file.text, 'python');
    const classes = findClasses(code);
    const byName = new Map<string, PyClass>();
    for (const c of classes) byName.set(c.name, c);

    const isSqlModel = (c: PyClass, seen = new Set<string>()): boolean => {
      if (c.kw.has('table')) return true;
      for (const b of c.baseNames) {
        if (b === 'SQLModel') return true;
        const bc = byName.get(b);
        if (bc && !seen.has(b)) {
          seen.add(b);
          if (isSqlModel(bc, seen)) return true;
        }
      }
      return false;
    };
    const sqlModelNames = new Set<string>();
    for (const c of classes) if (isSqlModel(c)) sqlModelNames.add(c.name);

    for (const c of classes) {
      if (c.name === 'Meta' || !sqlModelNames.has(c.name)) continue;
      emitModel(code, file, c, sqlModelNames, res);
    }
    return res;
  },
};

function emitModel(code: Code, file: SourceFile, c: PyClass, sqlModelNames: Set<string>, res: ParseResult): void {
  const concrete = boolValue(c.kw.get('table') ?? '') === true;
  const members = classMembers(code, c);
  const columns: Column[] = [];
  let tableName: string | undefined;
  let certainty: 0 | 1 | 2 = 0;

  for (const mem of members) {
    if (mem.name === '__tablename__') {
      const v = stringValue(mem.valueText ?? '');
      if (v) {
        tableName = v;
        certainty = 2;
      }
      continue;
    }
    if (mem.name.startsWith('__') || mem.isClass || mem.isDef || mem.isDecorator) continue;
    if (!mem.annotation) continue;

    if (mem.callBase === 'Relationship') {
      const rel = relationshipM2M(code, file, c.name, mem);
      if (rel) res.relations.push(rel);
      continue;
    }

    const ann = unwrapOptional(mem.annotation);
    const args = mem.callBase === 'Field' && mem.callOpen !== undefined ? code.args(mem.callOpen) : undefined;
    const primary = args ? namedBool(args, 'primary_key') === true : false;
    const col = column(mem.name, ann.type && ann.type !== 'None' ? ann.type : '', {
      nullable: primary ? false : ann.optional,
      primaryKey: primary,
      unique: args ? namedBool(args, 'unique') === true : false,
      source: sourceRef(file, mem.line),
    });
    if (args) {
      const def = namedText(args, 'default');
      if (def !== undefined && def !== 'None') col.default = def;
      const fk = namedString(args, 'foreign_key');
      if (fk) res.relations.push(fkRelation(file, c.name, mem.name, fk, col.nullable, mem.line));
    }
    columns.push(col);
  }

  if (!tableName) {
    tableName = c.name.toLowerCase();
    certainty = 0;
  }
  const entity: RawEntity = {
    name: tableName,
    kind: 'table',
    modelName: c.name,
    nameCertainty: certainty,
    columns,
    source: sourceRef(file, c.line),
  };
  if (!concrete) entity.abstract = true;
  const extendsBases = c.baseNames.filter((b) => b !== 'SQLModel' && sqlModelNames.has(b));
  if (extendsBases.length) entity.extends = extendsBases;
  const comment = docstring(code, c);
  if (comment) entity.comment = comment;
  res.entities.push(entity);
}

function fkRelation(file: SourceFile, model: string, colName: string, foreignKey: string, nullable: boolean, line: number): RawRelation {
  const dot = foreignKey.lastIndexOf('.');
  const table = dot >= 0 ? foreignKey.slice(0, dot) : foreignKey;
  const col = dot >= 0 ? foreignKey.slice(dot + 1) : undefined;
  return {
    from: { model },
    fromColumns: [colName],
    to: { name: table },
    toColumns: col ? [col] : [],
    cardinality: 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: sourceRef(file, line),
  };
}

function relationshipM2M(code: Code, file: SourceFile, model: string, mem: PyMember): RawRelation | undefined {
  if (mem.callOpen === undefined) return undefined;
  const args = code.args(mem.callOpen);
  const link = namedText(args, 'link_model');
  if (!link) return undefined;
  const target = modelInAnnotation(mem.annotation);
  if (!target) return undefined;
  const through: EntityRef = { model: tail(link) };
  return {
    from: { model },
    fromColumns: [],
    to: { model: target },
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    through,
    source: sourceRef(file, mem.line),
  };
}

/** Probable model name inside a `list["Team"]` / `List[Team]` / `Optional[Team]` annotation. */
function modelInAnnotation(annotation: string | undefined): string | undefined {
  if (!annotation) return undefined;
  const names = annotation.match(/[A-Za-z_]\w*/g) ?? [];
  for (let i = names.length - 1; i >= 0; i--) if (!WRAPPERS.has(names[i])) return names[i];
  return undefined;
}
