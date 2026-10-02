/**
 * Django ORM parser (`models.py`, `models/*.py`).
 *
 * Reads `class X(models.Model | AbstractUser | AbstractBaseUser | <base>)` definitions: fields, the
 * foreign-key / one-to-one / many-to-many associations they declare, the implicit `id` primary key,
 * `class Meta` options (db_table, abstract, proxy, unique_together, indexes, constraints) and
 * `TextChoices` / `IntegerChoices` enumerations.
 */

import type { Column, EntityRef, IndexDef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { baseName, column, dirName, pathSegments, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName } from '../core/naming';
import { boolValue, numberValue, stringValue } from '../core/text';
import { Code } from '../core/text';
import {
  bracketAt,
  classMembers,
  docstring,
  findCalls,
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

const MODEL_BASES = new Set(['Model', 'AbstractUser', 'AbstractBaseUser', 'AbstractEmailUser', 'PolymorphicModel']);
const CHOICES_BASES = new Set(['TextChoices', 'IntegerChoices', 'Choices']);
/** Django built-in bases that are not workspace abstract models (so no `extends` is emitted for them). */
const BUILTIN_BASES = new Set([...MODEL_BASES, 'object', 'PermissionsMixin', 'models.Model']);

const ON_DELETE: Readonly<Record<string, string>> = {
  CASCADE: 'CASCADE',
  SET_NULL: 'SET NULL',
  SET_DEFAULT: 'SET DEFAULT',
  PROTECT: 'RESTRICT',
  RESTRICT: 'RESTRICT',
  DO_NOTHING: 'NO ACTION',
};

function appLabel(path: string): string {
  const segs = pathSegments(dirName(path));
  if (!segs.length) return '';
  const base = baseName(path).toLowerCase();
  if (base === 'models.py') return segs[segs.length - 1];
  const idx = segs.lastIndexOf('models');
  if (idx > 0) return segs[idx - 1];
  return segs[segs.length - 1];
}

function fieldKind(mem: PyMember): 'fk' | 'o2o' | 'm2m' | 'field' | undefined {
  const b = mem.callBase;
  if (!b) return undefined;
  if (b === 'ForeignKey' || b === 'ForeignKeyField') return 'fk';
  if (b === 'OneToOneField') return 'o2o';
  if (b === 'ManyToManyField') return 'm2m';
  if (b === 'GenericForeignKey' || b === 'GenericRelation') return undefined;
  if (/Field$/.test(b)) return 'field';
  return undefined;
}

function targetRef(raw: string | undefined, current: string): EntityRef | undefined {
  if (!raw) return undefined;
  const val = stringValue(raw) ?? raw.trim();
  if (/AUTH_USER_MODEL/.test(val) || /get_user_model/.test(val)) return { name: 'auth_user', model: 'User' };
  if (val === 'self') return { model: current };
  const name = tail(val);
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  return { model: name };
}

export const djangoParser: SchemaParser = {
  kind: 'django',
  extensions: ['.py'],
  detect(file: SourceFile): boolean {
    if (pathSegments(file.path).includes('migrations')) return false;
    const t = file.text;
    if (!/django/.test(t)) return false;
    return (
      /\bmodels\.Model\b/.test(t) ||
      /\bAbstract(User|BaseUser)\b/.test(t) ||
      /models\.\w+Field\s*\(/.test(t) ||
      /models\.(ForeignKey|OneToOneField|ManyToManyField)\s*\(/.test(t)
    );
  },
  parse(file: SourceFile): ParseResult {
    const res = emptyResult('definition');
    if (pathSegments(file.path).includes('migrations')) return res;
    const code = new Code(file.text, 'python');
    const classes = findClasses(code);
    const app = appLabel(file.path);

    const choiceClasses = new Set<string>();
    for (const c of classes) if (c.baseNames.some((b) => CHOICES_BASES.has(b))) choiceClasses.add(c.name);

    // Which classes are Django models? (base, django field, or extends another model.)
    const direct = new Map<string, PyClass>();
    for (const c of classes) {
      if (choiceClasses.has(c.name) || c.name === 'Meta') continue;
      const hasModelBase = c.baseNames.some((b) => MODEL_BASES.has(b));
      const hasField = classMembers(code, c).some((m) => fieldKind(m) !== undefined);
      if (hasModelBase || hasField) direct.set(c.name, c);
    }
    const isModel = (c: PyClass): boolean =>
      direct.has(c.name) || c.baseNames.some((b) => direct.has(b) || (!BUILTIN_BASES.has(b) && !CHOICES_BASES.has(b) && classes.some((x) => x.name === b)));

    for (const c of classes) {
      if (choiceClasses.has(c.name)) {
        emitChoices(code, c, file, res);
        continue;
      }
      if (c.name === 'Meta' || !isModel(c)) continue;
      emitModel(code, classes, c, app, file, res);
    }
    return res;
  },
};

function emitModel(code: Code, classes: readonly PyClass[], c: PyClass, app: string, file: SourceFile, res: ParseResult): void {
  const members = classMembers(code, c);
  const meta = parseMeta(code, classes, c);
  if (meta.proxy) return; // proxy models reuse their parent's table

  const columns: Column[] = [];
  let hasExplicitPk = false;

  for (const mem of members) {
    const kind = fieldKind(mem);
    if (!kind || mem.callOpen === undefined) continue;
    const args = code.args(mem.callOpen);
    const dbColumn = namedString(args, 'db_column');
    const nullable = namedBool(args, 'null') === true;

    if (kind === 'm2m') {
      res.relations.push(m2mRelation(c.name, mem, args, app, file));
      continue;
    }
    if (kind === 'fk' || kind === 'o2o') {
      const colName = dbColumn ?? `${mem.name}_id`;
      const primary = namedBool(args, 'primary_key') === true || namedBool(args, 'parent_link') === true;
      if (primary) hasExplicitPk = true;
      columns.push(
        column(colName, '', {
          nullable: nullable && !primary,
          primaryKey: primary,
          unique: kind === 'o2o' || namedBool(args, 'unique') === true,
          source: sourceRef(file, mem.line),
        }),
      );
      res.relations.push(fkRelation(c.name, colName, kind, mem, args, nullable, file));
      continue;
    }

    // Scalar field.
    if (mem.callBase === 'AutoField' || mem.callBase === 'BigAutoField' || mem.callBase === 'SmallAutoField') hasExplicitPk = true;
    const primary = namedBool(args, 'primary_key') === true;
    if (primary) hasExplicitPk = true;
    const col = column(dbColumn ?? mem.name, typeName(mem.callBase), {
      nullable: nullable && !primary,
      primaryKey: primary,
      unique: namedBool(args, 'unique') === true,
      source: sourceRef(file, mem.line),
    });
    const def = namedText(args, 'default');
    if (def !== undefined) col.default = def;
    const comment = namedString(args, 'db_comment');
    if (comment !== undefined) col.comment = comment;
    const choices = namedText(args, 'choices');
    if (choices) {
      const enumName = tail(choices.replace(/\.choices$/, ''));
      if (/^[A-Z]/.test(enumName)) col.enumRef = enumName;
    }
    columns.push(col);
  }

  const abstract = meta.abstract;
  if (!abstract && !hasExplicitPk && !columns.some((col) => col.name === 'id')) {
    columns.unshift(column('id', 'BigAutoField', { nullable: false, primaryKey: true, generated: true }));
  }

  const name = meta.dbTable ?? defaultTableName('django', c.name, { appLabel: app });
  const extendsBases = c.baseNames.filter((b) => !BUILTIN_BASES.has(b) && !CHOICES_BASES.has(b));
  const entity: RawEntity = {
    name,
    kind: 'table',
    modelName: c.name,
    nameCertainty: meta.dbTable ? 2 : 0,
    columns,
    source: sourceRef(file, c.line),
  };
  if (app) entity.group = app;
  if (abstract) entity.abstract = true;
  if (extendsBases.length) entity.extends = extendsBases;
  if (meta.indexes.length) entity.indexes = meta.indexes;
  const comment = meta.comment ?? docstring(code, c);
  if (comment) entity.comment = comment;
  res.entities.push(entity);
}

function fkRelation(
  model: string,
  colName: string,
  kind: 'fk' | 'o2o',
  mem: PyMember,
  args: ReturnType<Code['args']>,
  nullable: boolean,
  file: SourceFile,
): RawRelation {
  const target = targetRef(positionalText(args, 0) ?? namedText(args, 'to'), model) ?? { model };
  const toField = namedString(args, 'to_field');
  const rel: RawRelation = {
    from: { model },
    fromColumns: [colName],
    to: target,
    toColumns: toField ? [toField] : [],
    cardinality: kind === 'o2o' ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    optional: nullable,
    source: sourceRef(file, mem.line),
  };
  const onDelete = namedText(args, 'on_delete');
  if (onDelete) {
    const token = tail(onDelete);
    rel.onDelete = ON_DELETE[token] ?? token;
  }
  return rel;
}

function m2mRelation(model: string, mem: PyMember, args: ReturnType<Code['args']>, app: string, file: SourceFile): RawRelation {
  const target = targetRef(positionalText(args, 0) ?? namedText(args, 'to'), model) ?? { model };
  const through = namedText(args, 'through');
  const dbTable = namedString(args, 'db_table');
  let throughRef: EntityRef;
  if (through) {
    const tv = stringValue(through) ?? through;
    throughRef = { model: tail(tv) };
  } else if (dbTable) {
    throughRef = { name: dbTable };
  } else {
    throughRef = { name: `${app ? app + '_' : ''}${model.toLowerCase()}_${mem.name.toLowerCase()}` };
  }
  return {
    from: { model },
    fromColumns: [],
    to: target,
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    through: throughRef,
    source: sourceRef(file, mem.line),
  };
}

interface Meta {
  dbTable?: string;
  abstract: boolean;
  proxy: boolean;
  comment?: string;
  indexes: IndexDef[];
}

function parseMeta(code: Code, classes: readonly PyClass[], c: PyClass): Meta {
  const meta: Meta = { abstract: false, proxy: false, indexes: [] };
  const metaClass = nestedClass(code, classes, c, 'Meta');
  if (!metaClass) return meta;
  for (const mem of classMembers(code, metaClass)) {
    if (mem.name === 'db_table') meta.dbTable = stringValue(mem.valueText ?? '');
    else if (mem.name === 'db_table_comment') meta.comment = stringValue(mem.valueText ?? '');
    else if (mem.name === 'abstract') meta.abstract = boolValue(mem.valueText ?? '') === true;
    else if (mem.name === 'proxy') meta.proxy = boolValue(mem.valueText ?? '') === true;
    else if (mem.name === 'unique_together' && mem.valueStart !== undefined) {
      for (const cols of parseUniqueTogether(code, mem)) {
        if (cols.length) meta.indexes.push({ columns: cols, unique: true });
      }
    } else if ((mem.name === 'indexes' || mem.name === 'constraints') && mem.valueStart !== undefined) {
      const unique = mem.name === 'constraints';
      const want = mem.name === 'indexes' ? ['Index'] : ['UniqueConstraint'];
      for (const call of findCalls(code, mem.valueStart, mem.end, want)) {
        const a = code.args(call.open);
        const cols = quotedList(namedText(a, 'fields') ?? positionalText(a, 0) ?? '');
        if (!cols.length) continue;
        const ix: IndexDef = { columns: cols, unique };
        const ixName = namedString(a, 'name');
        if (ixName) ix.name = ixName;
        meta.indexes.push(ix);
      }
    }
  }
  return meta;
}

function parseUniqueTogether(code: Code, mem: PyMember): string[][] {
  const open = bracketAt(code, mem.valueStart!, mem.end);
  if (open < 0) return [quotedList(mem.valueText ?? '')];
  const items = code.items(open);
  if (items.length && (items[0].text.startsWith('(') || items[0].text.startsWith('['))) {
    return items.map((it) => quotedList(it.text));
  }
  return [quotedList(mem.valueText ?? '')];
}

function emitChoices(code: Code, c: PyClass, file: SourceFile, res: ParseResult): void {
  const values: string[] = [];
  for (const mem of classMembers(code, c)) {
    if (!mem.valueText || mem.isClass || mem.isDef || mem.isDecorator) continue;
    if (!/^[A-Z]/.test(mem.name)) continue; // enum members are UPPER_CASE constants
    const first = firstItem(code, mem);
    const str = stringValue(first);
    const num = numberValue(first);
    if (str !== undefined) values.push(str);
    else if (num !== undefined) values.push(String(num));
  }
  if (values.length) {
    res.enums.push({ name: c.name, values: [...new Set(values)], source: sourceRef(file, c.line) });
  }
}

function firstItem(code: Code, mem: PyMember): string {
  if (mem.valueStart === undefined) return mem.valueText ?? '';
  const parts = code.split(mem.valueStart, mem.end, ',');
  return parts.length ? parts[0].text : (mem.valueText ?? '');
}
