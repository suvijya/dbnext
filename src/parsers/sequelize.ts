/**
 * Sequelize parser (`.ts` / `.js` …): model definitions and migrations.
 *
 * Definitions:
 *  - `sequelize.define('User', {attrs}, {options})`
 *  - `class User extends Model {}` + `User.init({attrs}, {options})` (incl. sequelize-cli factories)
 *  - sequelize-typescript `@Table` / `@Column` / `@ForeignKey` / `@BelongsTo` / `@HasMany` / …
 *  - associations: `A.belongsTo/hasMany/hasOne/belongsToMany(B, {…})`, including `static associate`
 *
 * Migrations (origin 'migration', UP only): `queryInterface.createTable / addColumn / removeColumn /
 * renameColumn / changeColumn / dropTable / renameTable / addConstraint / removeConstraint / addIndex`.
 */

import type { Column, ColumnPatch, EntityRef, IndexDef, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { camelCase, defaultTableName, snakeCase } from '../core/naming';
import { boolValue, Code, type Span, stringValue } from '../core/text';
import { JS_EXTENSIONS, type ClassDef, type Decorator, findClasses, lastSegment, refModel, sequelizeType } from './shared/jsmodels';

const MIGRATION_OPS = /queryInterface\s*\.\s*(createTable|addColumn|removeColumn|renameColumn|changeColumn|dropTable|renameTable|addConstraint|removeConstraint|addIndex)\b/;

interface ModelOptions {
  tableName?: string;
  freezeTableName?: boolean;
  underscored?: boolean;
  timestamps?: boolean;
  paranoid?: boolean;
  createdAt?: string | false;
  updatedAt?: string | false;
  deletedAt?: string | false;
  schema?: string;
  modelName?: string;
}

interface AttrResult {
  column: Column;
  ref?: { table: string; schema?: string; key?: string; onDelete?: string };
}

export const sequelizeParser: SchemaParser = {
  kind: 'sequelize',
  extensions: [...JS_EXTENSIONS],
  detect(file: SourceFile): boolean {
    const t = file.text;
    if (/from\s+['"]sequelize(?:-typescript)?['"]/.test(t) || /require\(\s*['"]sequelize(?:-typescript)?['"]\s*\)/.test(t)) return true;
    if (t.includes('queryInterface') && MIGRATION_OPS.test(t)) return true;
    if (/\.\s*define\s*\(/.test(t) && /\b(sequelize|DataTypes)\b/.test(t)) return true;
    if (/\.\s*init\s*\(/.test(t) && /\bDataTypes\b/.test(t) && /extends\s+\w*Model\b/.test(t)) return true;
    return false;
  },
  parse,
};

function parse(file: SourceFile): ParseResult {
  if (!file.text) return emptyResult('definition');
  const code = new Code(file.text, 'js');
  if (MIGRATION_OPS.test(code.masked)) return parseMigration(file, code);
  return parseDefinitions(file, code);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseDefinitions(file: SourceFile, code: Code): ParseResult {
  const result = emptyResult('definition');
  const classes = findClasses(code);
  const varToModel = new Map<string, string>();
  const underscoredByModel = new Map<string, boolean>();

  // sequelize.define('Name', {...}, {...})
  for (const m of matchCalls(code, /([A-Za-z_$][\w$]*)\s*\.\s*define\s*\(/g)) {
    const args = code.args(m.open);
    const nameSpan = args.positional[0];
    const attrs = args.positional[1];
    const modelName = nameSpan ? stringValue(nameSpan.text) : undefined;
    if (!modelName || !attrs || attrs.text[0] !== '{') continue;
    const options = args.positional[2]?.text[0] === '{' ? parseModelOptions(code, args.positional[2].start) : {};
    const v = assignedVar(code, m.start);
    if (v) varToModel.set(v, modelName);
    varToModel.set(modelName, modelName);
    underscoredByModel.set(modelName, !!options.underscored);
    const columns = parseAttributes(result, file, code, { model: modelName }, attrs.start, !!options.underscored);
    emitModel(result, file, modelName, columns, options, code.lineAt(m.start));
  }

  // class-based: sequelize-typescript (@Table / @Column) or classic `.init`
  for (const cls of classes) {
    const hasDecoratorCols = cls.members.some((mem) => mem.decorators.some((d) => COLUMN_DECS.has(d.name) || ASSOC_DECS.has(d.name)));
    const hasTable = cls.decorators.some((d) => d.name === 'Table');
    if (hasDecoratorCols || hasTable) {
      parseTsClass(result, file, code, cls, underscoredByModel);
      varToModel.set(cls.name, cls.name);
      continue;
    }
    // classic: ClassName.init({...}, {...})
    const init = findInit(code, cls.name);
    if (!init) continue;
    const args = code.args(init);
    const attrs = args.positional[0];
    if (!attrs || attrs.text[0] !== '{') continue;
    const options = args.positional[1]?.text[0] === '{' ? parseModelOptions(code, args.positional[1].start) : {};
    const modelName = options.modelName ?? cls.name;
    varToModel.set(cls.name, modelName);
    varToModel.set(modelName, modelName);
    underscoredByModel.set(modelName, !!options.underscored);
    const columns = parseAttributes(result, file, code, { model: modelName }, attrs.start, !!options.underscored);
    emitModel(result, file, modelName, columns, options, cls.line);
  }

  scanAssociations(result, file, code, classes, varToModel, underscoredByModel);
  return result;
}

function emitModel(result: ParseResult, file: SourceFile, modelName: string, columns: Column[], opts: ModelOptions, line: number): void {
  const src = () => sourceRef(file, line);
  // implicit primary key
  if (!columns.some((c) => c.primaryKey)) {
    const existing = columns.find((c) => c.name.toLowerCase() === 'id');
    if (existing) {
      existing.primaryKey = true;
      existing.nullable = false;
    } else {
      columns.unshift(column('id', 'INTEGER', { primaryKey: true, nullable: false, generated: true, source: src() }));
    }
  }
  // timestamps (default on)
  if (opts.timestamps !== false) {
    const u = opts.underscored;
    if (opts.createdAt !== false) {
      const n = typeof opts.createdAt === 'string' ? opts.createdAt : u ? 'created_at' : 'createdAt';
      if (!columns.some((c) => c.name === n)) columns.push(column(n, 'DATE', { nullable: false, source: src() }));
    }
    if (opts.updatedAt !== false) {
      const n = typeof opts.updatedAt === 'string' ? opts.updatedAt : u ? 'updated_at' : 'updatedAt';
      if (!columns.some((c) => c.name === n)) columns.push(column(n, 'DATE', { nullable: false, source: src() }));
    }
  }
  if (opts.paranoid) {
    const n = typeof opts.deletedAt === 'string' ? opts.deletedAt : opts.underscored ? 'deleted_at' : 'deletedAt';
    if (!columns.some((c) => c.name === n)) columns.push(column(n, 'DATE', { nullable: true, source: src() }));
  }

  let name: string;
  let certainty: 0 | 1 | 2;
  if (opts.tableName) {
    name = opts.tableName;
    certainty = 2;
  } else if (opts.freezeTableName) {
    name = modelName;
    certainty = 1;
  } else {
    name = defaultTableName('sequelize', modelName);
    certainty = 0;
  }
  const entity: RawEntity = { name, kind: 'table', modelName, nameCertainty: certainty, columns, source: src() };
  if (opts.schema) entity.schema = opts.schema;
  result.entities.push(entity);
}

function parseModelOptions(code: Code, open: number): ModelOptions {
  const obj = code.object(open);
  const out: ModelOptions = {};
  const str = (k: string) => stringValue(obj.get(k)?.text ?? '');
  out.tableName = str('tableName');
  out.freezeTableName = boolValue(obj.get('freezeTableName')?.text) === true;
  out.underscored = boolValue(obj.get('underscored')?.text) === true;
  const ts = obj.get('timestamps');
  out.timestamps = ts ? boolValue(ts.text) : undefined;
  out.paranoid = boolValue(obj.get('paranoid')?.text) === true;
  out.createdAt = tsName(obj.get('createdAt'));
  out.updatedAt = tsName(obj.get('updatedAt'));
  out.deletedAt = tsName(obj.get('deletedAt'));
  out.schema = str('schema');
  out.modelName = str('modelName');
  return out;
}

function tsName(span: Span | undefined): string | false | undefined {
  if (!span) return undefined;
  if (boolValue(span.text) === false) return false;
  return stringValue(span.text);
}

/** Parses an attributes object (`define` / `init` / `createTable`) into columns + reference relations. */
function parseAttributes(result: ParseResult, file: SourceFile, code: Code, from: EntityRef, attrsOpen: number, underscored: boolean): Column[] {
  const columns: Column[] = [];
  for (const [key, span] of code.object(attrsOpen)) {
    const r = parseAttrValue(code, file, key, span, underscored);
    columns.push(r.column);
    if (r.ref) pushRef(result, file, from, r.column.name, r.ref, code.lineAt(span.start));
  }
  return columns;
}

function pushRef(result: ParseResult, file: SourceFile, from: EntityRef, fkColumn: string, ref: AttrResult['ref'] & {}, line: number): void {
  const rel: RawRelation = {
    from: { ...from },
    fromColumns: [fkColumn],
    to: { name: ref.table, ...(ref.schema ? { schema: ref.schema } : {}) },
    toColumns: ref.key ? [ref.key] : [],
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    source: sourceRef(file, line),
  };
  if (ref.onDelete) rel.onDelete = ref.onDelete;
  result.relations.push(rel);
}

/** One attribute: `field: DataTypes.X` or `field: { type, allowNull, field, primaryKey, … }`. */
function parseAttrValue(code: Code, file: SourceFile, key: string, span: Span, underscored: boolean): AttrResult {
  const line = code.lineAt(span.start);
  const t = span.text.trim();
  const props: Partial<Column> = { nullable: true, source: sourceRef(file, line) };
  let type = '';
  let colName = underscored ? snakeCase(key) : key;
  let ref: AttrResult['ref'];

  if (t[0] === '{') {
    const obj = code.object(span.start);
    type = sequelizeType(obj.get('type')?.text);
    const field = stringValue(obj.get('field')?.text);
    if (field) colName = field;
    const pk = boolValue(obj.get('primaryKey')?.text) === true;
    if (pk) {
      props.primaryKey = true;
      props.nullable = false;
    }
    if (boolValue(obj.get('autoIncrement')?.text) === true) props.generated = true;
    const u = obj.get('unique');
    if (u && boolValue(u.text) !== false) props.unique = true;
    const allowNull = boolValue(obj.get('allowNull')?.text);
    if (allowNull === false && !pk) props.nullable = false;
    const comment = stringValue(obj.get('comment')?.text);
    if (comment) props.comment = comment;
    applyDefaultValue(obj.get('defaultValue'), props);
    ref = parseReferences(code, obj.get('references'), obj.get('onDelete'));
  } else {
    type = sequelizeType(t);
  }

  return { column: column(colName, type, props), ref };
}

function applyDefaultValue(span: Span | undefined, props: Partial<Column>): void {
  if (!span) return;
  const t = span.text.trim();
  if (/\b(NOW|UUIDV1|UUIDV4)\b/.test(t) || /\.(literal|fn)\s*\(/.test(t)) {
    props.generated = true;
    return;
  }
  const v = stringValue(t);
  props.default = v ?? t;
}

function parseReferences(code: Code, span: Span | undefined, onDeleteSpan: Span | undefined): AttrResult['ref'] {
  if (!span || span.text[0] !== '{') return undefined;
  const obj = code.object(span.start);
  const modelV = obj.get('model');
  if (!modelV) return undefined;
  let table: string | undefined;
  let schema: string | undefined;
  if (modelV.text[0] === '{') {
    const mo = code.object(modelV.start);
    table = stringValue(mo.get('tableName')?.text);
    schema = stringValue(mo.get('schema')?.text);
  } else {
    table = stringValue(modelV.text) ?? lastSegment(modelV.text);
  }
  if (!table) return undefined;
  return { table, schema, key: stringValue(obj.get('key')?.text), onDelete: stringValue(onDeleteSpan?.text) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// sequelize-typescript class
// ─────────────────────────────────────────────────────────────────────────────────────────────

const COLUMN_DECS = new Set(['Column', 'PrimaryKey', 'AutoIncrement', 'AllowNull', 'Unique', 'Default', 'CreatedAt', 'UpdatedAt', 'DeletedAt', 'ForeignKey', 'Comment']);
const ASSOC_DECS = new Set(['BelongsTo', 'HasMany', 'HasOne', 'BelongsToMany']);

function parseTsClass(result: ParseResult, file: SourceFile, code: Code, cls: ClassDef, underscoredByModel: Map<string, boolean>): void {
  const tableDec = cls.decorators.find((d) => d.name === 'Table');
  const options = tableDec && tableDec.open >= 0 ? tableDecoratorOptions(code, tableDec) : {};
  const underscored = !!options.underscored;
  underscoredByModel.set(cls.name, underscored);

  const fkByTarget = new Map<string, string>();
  const columns: Column[] = [];

  for (const mem of cls.members) {
    if (mem.kind !== 'prop') continue;
    const decs = mem.decorators;
    const fk = decs.find((d) => d.name === 'ForeignKey');
    const isColumn = decs.some((d) => COLUMN_DECS.has(d.name));
    if (!isColumn) continue;
    const col = buildTsColumn(code, file, mem, decs, underscored);
    columns.push(col);
    if (fk && fk.open >= 0) {
      const target = refModel(firstArgText(code, fk));
      if (target) fkByTarget.set(target, col.name);
    }
  }

  // associations declared with decorators
  for (const mem of cls.members) {
    for (const d of mem.decorators) {
      if (!ASSOC_DECS.has(d.name) || d.open < 0) continue;
      handleTsAssociation(result, file, code, cls.name, d, mem.line, fkByTarget, underscored, underscoredByModel);
    }
  }

  emitModel(result, file, cls.name, columns, options, cls.line);
}

function buildTsColumn(code: Code, file: SourceFile, mem: { name: string; type: string; line: number }, decs: Decorator[], underscored: boolean): Column {
  const has = (n: string) => decs.some((d) => d.name === n);
  const get = (n: string) => decs.find((d) => d.name === n);
  const props: Partial<Column> = { nullable: true, source: sourceRef(file, mem.line) };

  let colName = underscored ? snakeCase(mem.name) : mem.name;
  let type = '';

  const colDec = get('Column');
  if (colDec && colDec.open >= 0) {
    const first = code.args(colDec.open).positional[0];
    if (first) {
      if (first.text[0] === '{') {
        const obj = code.object(first.start);
        const field = stringValue(obj.get('field')?.text);
        if (field) colName = field;
        type = sequelizeType(obj.get('type')?.text);
        const u = obj.get('unique');
        if (u && boolValue(u.text) !== false) props.unique = true;
        if (boolValue(obj.get('allowNull')?.text) === false) props.nullable = false;
        applyDefaultValue(obj.get('defaultValue'), props);
      } else {
        type = sequelizeType(first.text);
      }
    }
  }
  if (!type) type = tsToSequelize(mem.type);

  if (has('PrimaryKey')) {
    props.primaryKey = true;
    props.nullable = false;
  }
  if (has('AutoIncrement')) props.generated = true;
  if (has('Unique')) props.unique = true;
  const allowNull = get('AllowNull');
  if (allowNull && allowNull.open >= 0 && boolValue(firstArgText(code, allowNull)) === false) props.nullable = false;
  const def = get('Default');
  if (def && def.open >= 0) applyDefaultValue(code.args(def.open).positional[0], props);
  if (has('CreatedAt') || has('UpdatedAt') || has('DeletedAt')) {
    type = type || 'DATE';
    if (has('DeletedAt')) props.nullable = true;
    else props.nullable = false;
  }
  return column(colName, type, props);
}

function tableDecoratorOptions(code: Code, dec: Decorator): ModelOptions {
  const first = code.args(dec.open).positional[0];
  return first && first.text[0] === '{' ? parseModelOptions(code, first.start) : {};
}

const TS_TO_SEQUELIZE: Readonly<Record<string, string>> = { string: 'STRING', number: 'INTEGER', boolean: 'BOOLEAN', date: 'DATE' };

function tsToSequelize(tsType: string): string {
  const t = tsType.trim().replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
  if (!t) return '';
  return TS_TO_SEQUELIZE[t.toLowerCase()] ?? '';
}

function handleTsAssociation(
  result: ParseResult,
  file: SourceFile,
  code: Code,
  source: string,
  d: Decorator,
  line: number,
  fkByTarget: Map<string, string>,
  underscored: boolean,
  underscoredByModel: Map<string, boolean>,
): void {
  const args = code.args(d.open);
  const target = refModel(args.positional[0]?.text);
  if (!target) return;
  const method = d.name;
  if (method === 'BelongsToMany') {
    const through = args.positional[1] ? throughRef(code, args.positional[1]) : undefined;
    result.relations.push(mkRel({ model: source }, [], { model: target }, [], 'many-to-many', line, file, through));
    return;
  }
  if (method === 'BelongsTo') {
    const fk = fkByTarget.get(target) ?? defaultFk(target, underscored);
    result.relations.push(mkRel({ model: source }, [fk], { model: target }, [], 'many-to-one', line, file));
    return;
  }
  if (method === 'HasOne') {
    const fk = defaultFk(source, underscoredByModel.get(target) ?? underscored);
    result.relations.push(mkRel({ model: target }, [fk], { model: source }, [], 'one-to-one', line, file));
    return;
  }
  // HasMany
  const fk = defaultFk(source, underscoredByModel.get(target) ?? underscored);
  result.relations.push(mkRel({ model: source }, [], { model: target }, [fk], 'one-to-many', line, file));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Call-based associations (A.belongsTo(B, {...}))
// ─────────────────────────────────────────────────────────────────────────────────────────────

function scanAssociations(
  result: ParseResult,
  file: SourceFile,
  code: Code,
  classes: ClassDef[],
  varToModel: Map<string, string>,
  underscoredByModel: Map<string, boolean>,
): void {
  const re = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(belongsTo|hasMany|hasOne|belongsToMany)\s*\(/g;
  const m = code.masked;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const open = mt.index + mt[0].length - 1;
    const chain = mt[1].replace(/\s+/g, '');
    const method = mt[2];
    const args = code.args(open);
    re.lastIndex = args.end;

    const recLast = lastSegment(chain);
    let source: string | undefined;
    if (chain === 'this' || recLast === 'this') source = enclosingClass(classes, mt.index)?.name;
    else source = varToModel.get(recLast) ?? recLast;
    if (!source) continue;

    const targetRaw = args.positional[0]?.text;
    const target0 = refModel(targetRaw);
    if (!target0) continue;
    const target = varToModel.get(target0) ?? target0;

    const opts = args.positional[1]?.text[0] === '{' ? code.object(args.positional[1].start) : new Map<string, Span>();
    const line = code.lineAt(mt.index);
    const fkOpt = fkName(code, opts.get('foreignKey'));
    const as = stringValue(opts.get('as')?.text);
    const onDelete = stringValue(opts.get('onDelete')?.text);
    const onUpdate = stringValue(opts.get('onUpdate')?.text);

    const srcU = underscoredByModel.get(source) ?? false;
    const tgtU = underscoredByModel.get(target) ?? srcU;

    if (method === 'belongsToMany') {
      const through = throughRef(code, opts.get('through'));
      result.relations.push(mkRel({ model: source }, [], { model: target }, [], 'many-to-many', line, file, through));
    } else if (method === 'belongsTo') {
      const fk = fkOpt ?? defaultFk(as ?? target, srcU);
      const targetKey = stringValue(opts.get('targetKey')?.text);
      result.relations.push(withHooks(mkRel({ model: source }, [fk], { model: target }, targetKey ? [targetKey] : [], 'many-to-one', line, file), onDelete, onUpdate));
    } else if (method === 'hasOne') {
      const fk = fkOpt ?? defaultFk(source, tgtU);
      result.relations.push(withHooks(mkRel({ model: target }, [fk], { model: source }, [], 'one-to-one', line, file), onDelete, onUpdate));
    } else {
      // hasMany
      const fk = fkOpt ?? defaultFk(source, tgtU);
      result.relations.push(withHooks(mkRel({ model: source }, [], { model: target }, [fk], 'one-to-many', line, file), onDelete, onUpdate));
    }
  }
}

function withHooks(rel: RawRelation, onDelete?: string, onUpdate?: string): RawRelation {
  if (onDelete) rel.onDelete = onDelete;
  if (onUpdate) rel.onUpdate = onUpdate;
  return rel;
}

function mkRel(
  from: EntityRef,
  fromColumns: string[],
  to: EntityRef,
  toColumns: string[],
  cardinality: RawRelation['cardinality'],
  line: number,
  file: SourceFile,
  through?: EntityRef,
): RawRelation {
  const rel: RawRelation = { from, fromColumns, to, toColumns, cardinality, kind: 'orm', source: sourceRef(file, line) };
  if (through) rel.through = through;
  return rel;
}

function fkName(code: Code, span: Span | undefined): string | undefined {
  if (!span) return undefined;
  if (span.text[0] === '{') return stringValue(code.object(span.start).get('name')?.text ?? '');
  return stringValue(span.text);
}

function throughRef(code: Code, span: Span | undefined): EntityRef | undefined {
  if (!span) return undefined;
  const t = span.text.trim();
  if (t[0] === '{') {
    const model = code.object(span.start).get('model');
    if (!model) return undefined;
    const s = stringValue(model.text);
    return s ? { name: s } : { model: refModel(model.text) };
  }
  const s = stringValue(t);
  if (s !== undefined) return { name: s };
  const m = refModel(t);
  return m ? { model: m } : undefined;
}

function defaultFk(base: string, underscored: boolean): string {
  const name = lastSegment(base);
  return underscored ? `${snakeCase(name)}_id` : `${camelCase(name)}Id`;
}

function enclosingClass(classes: ClassDef[], offset: number): ClassDef | undefined {
  let best: ClassDef | undefined;
  for (const c of classes) {
    if (offset > c.bodyOpen && offset < c.bodyClose) {
      if (!best || c.bodyOpen > best.bodyOpen) best = c;
    }
  }
  return best;
}

function findInit(code: Code, className: string): number | undefined {
  const re = new RegExp(`\\b${className}\\s*\\.\\s*init\\s*\\(`, 'g');
  const mt = re.exec(code.masked);
  return mt ? mt.index + mt[0].length - 1 : undefined;
}

function firstArgText(code: Code, dec: Decorator): string | undefined {
  if (dec.open < 0) return undefined;
  return code.args(dec.open).positional[0]?.text;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseMigration(file: SourceFile, code: Code): ParseResult {
  const result = emptyResult('migration');
  const range = findUpBody(code) ?? { start: 0, end: code.masked.length };
  const re = /queryInterface\s*\.\s*(createTable|addColumn|removeColumn|renameColumn|changeColumn|dropTable|renameTable|addConstraint|removeConstraint|addIndex)\s*\(/g;
  re.lastIndex = range.start;
  const m = code.masked;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m)) && mt.index < range.end) {
    const op = mt[1];
    const open = mt.index + mt[0].length - 1;
    const args = code.args(open);
    re.lastIndex = args.end;
    const line = code.lineAt(mt.index);
    applyMigrationOp(result, file, code, op, args.positional, line);
  }
  return result;
}

function applyMigrationOp(result: ParseResult, file: SourceFile, code: Code, op: string, pos: Span[], line: number): void {
  const str = (i: number) => (pos[i] ? stringValue(pos[i].text) ?? lastSegment(pos[i].text) : undefined);
  const ops = (result.ops ??= []);

  switch (op) {
    case 'createTable': {
      const table = str(0);
      if (!table || !pos[1] || pos[1].text[0] !== '{') return;
      const columns = parseAttributes(result, file, code, { name: table }, pos[1].start, false);
      result.entities.push({ name: table, kind: 'table', nameCertainty: 2, columns, source: sourceRef(file, line) });
      return;
    }
    case 'addColumn': {
      const table = str(0);
      const colName = str(1);
      if (!table || !colName || !pos[2] || pos[2].text[0] !== '{') return;
      const r = parseAttrValue(code, file, colName, pos[2], false);
      r.column.name = colName;
      result.entities.push({ name: table, kind: 'table', columns: [r.column], partial: true, source: sourceRef(file, line) });
      if (r.ref) pushRef(result, file, { name: table }, colName, r.ref, line);
      return;
    }
    case 'removeColumn': {
      const table = str(0);
      const colName = str(1);
      if (table && colName) ops.push({ op: 'dropColumn', table: { name: table }, column: colName, source: sourceRef(file, line) });
      return;
    }
    case 'renameColumn': {
      const table = str(0);
      const from = str(1);
      const to = str(2);
      if (table && from && to) ops.push({ op: 'renameColumn', table: { name: table }, column: from, to, source: sourceRef(file, line) });
      return;
    }
    case 'changeColumn': {
      const table = str(0);
      const colName = str(1);
      if (!table || !colName || !pos[2] || pos[2].text[0] !== '{') return;
      ops.push({ op: 'alterColumn', table: { name: table }, column: colName, set: buildPatch(code, pos[2].start), source: sourceRef(file, line) });
      return;
    }
    case 'dropTable': {
      const table = str(0);
      if (table) ops.push({ op: 'dropTable', table: { name: table }, source: sourceRef(file, line) });
      return;
    }
    case 'renameTable': {
      const from = str(0);
      const to = str(1);
      if (from && to) ops.push({ op: 'renameTable', table: { name: from }, to, source: sourceRef(file, line) });
      return;
    }
    case 'addConstraint':
      addConstraint(result, file, code, str(0), pos[1], line);
      return;
    case 'removeConstraint': {
      const table = str(0);
      const name = str(1);
      if (table && name) ops.push({ op: 'dropForeignKey', table: { name: table }, name, source: sourceRef(file, line) });
      return;
    }
    case 'addIndex':
      addIndexOp(result, file, code, str(0), pos, line);
      return;
  }
}

function buildPatch(code: Code, open: number): ColumnPatch {
  const obj = code.object(open);
  const patch: ColumnPatch = {};
  const type = sequelizeType(obj.get('type')?.text);
  if (type) patch.type = type;
  const allowNull = boolValue(obj.get('allowNull')?.text);
  if (allowNull !== undefined) patch.nullable = allowNull;
  const u = obj.get('unique');
  if (u) patch.unique = boolValue(u.text) !== false;
  if (boolValue(obj.get('primaryKey')?.text) === true) patch.primaryKey = true;
  const def = obj.get('defaultValue');
  if (def) patch.default = stringValue(def.text) ?? def.text.trim();
  return patch;
}

function addConstraint(result: ParseResult, file: SourceFile, code: Code, table: string | undefined, optsSpan: Span | undefined, line: number): void {
  if (!table || !optsSpan || optsSpan.text[0] !== '{') return;
  const obj = code.object(optsSpan.start);
  const type = (stringValue(obj.get('type')?.text) ?? '').toLowerCase().replace(/\s+/g, ' ');
  const fields = arrayStrings(code, obj.get('fields'));
  if (type.includes('foreign')) {
    const refSpan = obj.get('references');
    if (refSpan && refSpan.text[0] === '{') {
      const ro = code.object(refSpan.start);
      const toTable = stringValue(ro.get('table')?.text);
      const field = stringValue(ro.get('field')?.text);
      if (toTable) {
        const rel: RawRelation = {
          from: { name: table },
          fromColumns: fields,
          to: { name: toTable },
          toColumns: field ? [field] : [],
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          source: sourceRef(file, line),
        };
        const onDelete = stringValue(obj.get('onDelete')?.text);
        if (onDelete) rel.onDelete = onDelete;
        result.relations.push(rel);
      }
    }
  } else if (type.includes('unique') && fields.length) {
    result.entities.push({ name: table, kind: 'table', columns: [], partial: true, indexes: [{ columns: fields, unique: true }], source: sourceRef(file, line) });
  } else if (type.includes('primary') && fields.length) {
    for (const f of fields) {
      (result.ops ??= []).push({ op: 'alterColumn', table: { name: table }, column: f, set: { primaryKey: true }, source: sourceRef(file, line) });
    }
  }
}

function addIndexOp(result: ParseResult, file: SourceFile, code: Code, table: string | undefined, pos: Span[], line: number): void {
  if (!table) return;
  let fields: string[] = [];
  let unique = false;
  let name: string | undefined;
  if (pos[1] && pos[1].text[0] === '[') {
    fields = code.items(pos[1].start).map((s) => stringValue(s.text) ?? s.text.trim());
    if (pos[2] && pos[2].text[0] === '{') {
      const o = code.object(pos[2].start);
      unique = boolValue(o.get('unique')?.text) === true;
      name = stringValue(o.get('name')?.text);
    }
  } else if (pos[1] && pos[1].text[0] === '{') {
    const o = code.object(pos[1].start);
    fields = arrayStrings(code, o.get('fields'));
    unique = boolValue(o.get('unique')?.text) === true;
    name = stringValue(o.get('name')?.text);
  }
  if (!fields.length) return;
  const index: IndexDef = { columns: fields, unique };
  if (name) index.name = name;
  result.entities.push({ name: table, kind: 'table', columns: [], partial: true, indexes: [index], source: sourceRef(file, line) });
}

function arrayStrings(code: Code, span: Span | undefined): string[] {
  if (!span || span.text[0] !== '[') return [];
  return code.items(span.start).map((s) => stringValue(s.text) ?? s.text.trim()).filter(Boolean);
}

/** Range of the migration `up` function body, or `undefined` to scan the whole file. */
function findUpBody(code: Code): { start: number; end: number } | undefined {
  const m = code.masked;
  const patterns = [/\b(?:async\s+)?up\s*\(/g, /\bup\s*[:=]\s*(?:async\s*)?(?:function\b[^(]*)?\(/g];
  for (const re of patterns) {
    re.lastIndex = 0;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(m))) {
      const paren = mt.index + mt[0].length - 1;
      if (m[paren] !== '(') continue;
      const pclose = code.closing(paren);
      if (pclose < 0) continue;
      let b = pclose + 1;
      while (b < m.length && (m[b] === ' ' || m[b] === '\t' || m[b] === '\n' || m[b] === '\r')) b++;
      if (m[b] === '=' && m[b + 1] === '>') {
        b += 2;
        while (b < m.length && (m[b] === ' ' || m[b] === '\t' || m[b] === '\n' || m[b] === '\r')) b++;
      }
      while (b < m.length && m[b] !== '{' && m[b] !== ';' && m[b] !== '\n') b++;
      if (m[b] === '{') {
        const close = code.closing(b);
        if (close > b) return { start: b + 1, end: close };
      }
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// shared small utils
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Call {
  start: number;
  open: number;
}

function matchCalls(code: Code, re: RegExp): Call[] {
  const out: Call[] = [];
  const m = code.masked;
  re.lastIndex = 0;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const open = mt.index + mt[0].length - 1;
    out.push({ start: mt.index, open });
    re.lastIndex = open + 1;
  }
  return out;
}

function assignedVar(code: Code, offset: number): string | undefined {
  const s = code.stripped.slice(Math.max(0, offset - 240), offset);
  const m = /(?:^|[;{}\n)])\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*$/.exec(s);
  return m ? m[1] : undefined;
}
