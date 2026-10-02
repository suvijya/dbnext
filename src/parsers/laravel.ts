/**
 * Laravel parser: Eloquent models and the schema builder migrations.
 *
 *  - `database/migrations/*.php` (`Schema::create` / `Schema::table`, `up()` only) → migration history
 *  - `app/Models/*.php` (classes extending Model / Authenticatable / Pivot) → model definitions
 *
 * Doctrine also lives in `.php`; `detect` explicitly rejects files carrying Doctrine mapping markers.
 */

import type {
  Column,
  ColumnPatch,
  EntityRef,
  ParseResult,
  RawEntity,
  RawEnum,
  RawRelation,
  SchemaOp,
  SourceFile,
  SourceRef,
} from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName, pluralize, shortName, snakeCase } from '../core/naming';
import { type Args, Code, boolValue, stringValue } from '../core/text';
import { addColumn, inlineEnumName, listValues } from './shared/rubyphp';

const TYPES: Readonly<Record<string, string>> = {
  string: 'string',
  char: 'char',
  text: 'text',
  mediumText: 'text',
  longText: 'text',
  tinyText: 'text',
  integer: 'integer',
  bigInteger: 'bigint',
  tinyInteger: 'tinyint',
  smallInteger: 'smallint',
  mediumInteger: 'mediumint',
  unsignedBigInteger: 'bigint',
  unsignedInteger: 'integer',
  unsignedTinyInteger: 'tinyint',
  unsignedSmallInteger: 'smallint',
  unsignedMediumInteger: 'mediumint',
  boolean: 'boolean',
  decimal: 'decimal',
  unsignedDecimal: 'decimal',
  float: 'float',
  double: 'double',
  date: 'date',
  dateTime: 'datetime',
  dateTimeTz: 'datetime',
  time: 'time',
  timeTz: 'time',
  timestamp: 'timestamp',
  timestampTz: 'timestamp',
  year: 'year',
  json: 'json',
  jsonb: 'jsonb',
  binary: 'binary',
  uuid: 'uuid',
  ulid: 'ulid',
  ipAddress: 'ipAddress',
  macAddress: 'macAddress',
  geometry: 'geometry',
};

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/Doctrine\\ORM/.test(t) || /#\[\s*ORM\\/.test(t) || /@ORM\\/.test(t)) return false;
  if (/\bIlluminate\\Database\b/.test(t)) return true;
  if (/\bBlueprint\b/.test(t) && /\bSchema::(create|table|dropIfExists|drop|rename|connection)\b/.test(t)) return true;
  if (/\bextends\s+(?:Model|Authenticatable|Pivot|Eloquent)\b/.test(t)) return true;
  return false;
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'php');
  const isMigration =
    /\bSchema::(?:connection\s*\([^)]*\)\s*->\s*)?(?:create|table|drop|dropIfExists|rename)\b/.test(code.masked) ||
    /\bextends\s+Migration\b/.test(code.masked);
  return isMigration ? parseMigration(file, code) : parseModels(file, code);
}

// ── migrations ──────────────────────────────────────────────────────────────────────────────

interface Ctx {
  table: string;
  isCreate: boolean;
  file: string;
  columns: Column[];
  indexes: NonNullable<RawEntity['indexes']>;
  relations: RawRelation[];
  enums: RawEnum[];
  ops: SchemaOp[];
}

function parseMigration(file: SourceFile, code: Code): ParseResult {
  const m = code.masked;
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const enums: RawEnum[] = [];
  const ops: SchemaOp[] = [];

  let start = 0;
  let end = code.text.length;
  const um = /function\s+up\s*\(/.exec(m);
  if (um) {
    const close = code.closing(um.index + um[0].length - 1);
    const brace = m.indexOf('{', close < 0 ? um.index : close);
    const braceEnd = brace >= 0 ? code.closing(brace) : -1;
    if (brace >= 0 && braceEnd >= 0) {
      start = brace + 1;
      end = braceEnd;
    }
  }

  const re = /\bSchema::(?:connection\s*\([^)]*\)\s*->\s*)?(create|table|dropIfExists|drop|rename)\b/g;
  for (const sm of m.slice(start, end).matchAll(re)) {
    const kw = sm[1];
    const at = start + sm.index!;
    if (!code.isCode(at)) continue;
    const open = m.indexOf('(', at + sm[0].length);
    if (open < 0) continue;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    if (!name) continue;
    const line = code.lineAt(at);

    if (kw === 'drop' || kw === 'dropIfExists') {
      ops.push({ op: 'dropTable', table: { name }, source: sourceRef(file, line) });
      continue;
    }
    if (kw === 'rename') {
      const to = stringValue(args.positional[1]?.text);
      if (to) ops.push({ op: 'renameTable', table: { name }, to, source: sourceRef(file, line) });
      continue;
    }

    const bodyOpen = m.indexOf('{', open);
    const callClose = code.closing(open);
    if (bodyOpen < 0 || (callClose >= 0 && bodyOpen > callClose)) continue;
    const bodyClose = code.closing(bodyOpen);
    if (bodyClose < 0) continue;

    const ctx: Ctx = {
      table: name,
      isCreate: kw === 'create',
      file: file.path,
      columns: [],
      indexes: [],
      relations,
      enums,
      ops,
    };
    for (const stmt of code.split(bodyOpen + 1, bodyClose, ';')) processChain(code, stmt.start, stmt.end, ctx);

    if (kw === 'create') {
      entities.push({
        name,
        kind: 'table',
        columns: ctx.columns,
        ...(ctx.indexes.length ? { indexes: ctx.indexes } : {}),
        source: sourceRef(file, line),
      });
    } else if (ctx.columns.length || ctx.indexes.length) {
      entities.push({
        name,
        kind: 'table',
        partial: true,
        columns: ctx.columns,
        ...(ctx.indexes.length ? { indexes: ctx.indexes } : {}),
        source: sourceRef(file, line),
      });
    }
  }

  return { origin: 'migration', entities, relations, enums, ops };
}

interface Call {
  name: string;
  args: Args;
  at: number;
}

function parseChain(code: Code, start: number, end: number): Call[] {
  const calls: Call[] = [];
  for (const mm of code.masked.slice(start, end).matchAll(/->\s*(\w+)\s*\(/g)) {
    const open = start + mm.index! + mm[0].length - 1;
    calls.push({ name: mm[1], args: code.args(open), at: start + mm.index! });
  }
  return calls;
}

interface FkState {
  column: string;
  to?: string;
  toCol?: string;
  onDelete?: string;
  onUpdate?: string;
}

function processChain(code: Code, start: number, end: number, ctx: Ctx): void {
  const chain = parseChain(code, start, end);
  if (!chain.length) return;
  const def = chain[0];
  const mods = chain.slice(1);
  const line = code.lineAt(def.at);
  const ref = sourceRef(ctx.file, line);
  const changing = mods.some((c) => c.name === 'change');

  // Operations only valid inside Schema::table
  if (handleModification(def, ctx, ref)) return;

  const built = buildColumns(def, ctx, ref);
  if (!built) return;

  let fk = built.fk;
  for (const mod of mods) fk = applyModifier(mod, built.columns, fk);

  if (changing && !ctx.isCreate) {
    for (const c of built.columns) ctx.ops.push({ op: 'alterColumn', table: { name: ctx.table }, column: c.name, set: patchOf(c), source: ref });
  } else {
    for (const c of built.columns) addColumn(ctx.columns, c);
  }

  if (fk?.to) {
    const col = built.columns.find((c) => c.name === fk!.column);
    ctx.relations.push({
      from: { name: ctx.table },
      fromColumns: [fk.column],
      to: { name: fk.to },
      toColumns: fk.toCol ? [fk.toCol] : [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
      ...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
      optional: col ? col.nullable : undefined,
      source: ref,
    });
  }
}

/** Column drops / renames / FK drops that are only meaningful in `Schema::table`. Returns true if handled. */
function handleModification(def: Call, ctx: Ctx, ref: SourceRef): boolean {
  const name = def.name;
  const first = def.args.positional[0]?.text;
  switch (name) {
    case 'dropColumn':
    case 'dropColumns': {
      const cols = first && /^\[/.test(first.trim()) ? listValues(first) : [stringValue(first)].filter(Boolean) as string[];
      for (const c of cols) ctx.ops.push({ op: 'dropColumn', table: { name: ctx.table }, column: c, source: ref });
      return true;
    }
    case 'renameColumn': {
      const from = stringValue(first);
      const to = stringValue(def.args.positional[1]?.text);
      if (from && to) ctx.ops.push({ op: 'renameColumn', table: { name: ctx.table }, column: from, to, source: ref });
      return true;
    }
    case 'dropForeign': {
      if (first && /^\[/.test(first.trim())) {
        ctx.ops.push({ op: 'dropForeignKey', table: { name: ctx.table }, columns: listValues(first), source: ref });
      } else {
        const n = stringValue(first);
        if (n) ctx.ops.push({ op: 'dropForeignKey', table: { name: ctx.table }, name: n, source: ref });
      }
      return true;
    }
    case 'dropSoftDeletes':
    case 'dropSoftDeletesTz':
      ctx.ops.push({ op: 'dropColumn', table: { name: ctx.table }, column: stringValue(first) ?? 'deleted_at', source: ref });
      return true;
    case 'dropTimestamps':
    case 'dropTimestampsTz':
      for (const c of ['created_at', 'updated_at']) ctx.ops.push({ op: 'dropColumn', table: { name: ctx.table }, column: c, source: ref });
      return true;
    case 'dropMorphs': {
      const base = stringValue(first);
      if (base) for (const c of [`${base}_type`, `${base}_id`]) ctx.ops.push({ op: 'dropColumn', table: { name: ctx.table }, column: c, source: ref });
      return true;
    }
    case 'dropRememberToken':
      ctx.ops.push({ op: 'dropColumn', table: { name: ctx.table }, column: 'remember_token', source: ref });
      return true;
    case 'primary':
    case 'unique':
    case 'index':
    case 'fullText':
    case 'spatialIndex':
      handleIndex(def, ctx, ref);
      return true;
    default:
      return false;
  }
}

function handleIndex(def: Call, ctx: Ctx, ref: SourceRef): void {
  const first = def.args.positional[0]?.text;
  if (!first) return;
  const columns = /^\[/.test(first.trim()) ? listValues(first) : ([stringValue(first)].filter(Boolean) as string[]);
  if (!columns.length) return;
  if (def.name === 'primary') {
    for (const c of columns) {
      const col = ctx.columns.find((x) => x.name === c);
      if (col) {
        col.primaryKey = true;
        col.nullable = false;
      }
    }
    return;
  }
  const idxName = stringValue(def.args.positional[1]?.text);
  ctx.indexes.push({ columns, unique: def.name === 'unique', ...(idxName ? { name: idxName } : {}), source: ref });
}

interface Built {
  columns: Column[];
  fk?: FkState;
}

function buildColumns(def: Call, ctx: Ctx, ref: SourceRef): Built | undefined {
  const name = def.name;
  const first = def.args.positional[0]?.text;
  const colName = stringValue(first);
  const mk = (n: string, type: string, props: Partial<Column> = {}) => column(n, type, { nullable: false, source: ref, ...props });

  // auto-increment primary keys
  if (name === 'id') return { columns: [mk(colName ?? 'id', 'bigint', { primaryKey: true, generated: true })] };
  if (/^(bigIncrements|increments|mediumIncrements|smallIncrements|tinyIncrements)$/.test(name)) {
    return { columns: [mk(colName ?? 'id', 'bigint', { primaryKey: true, generated: true })] };
  }

  // foreign-key helpers
  if (name === 'foreignId' || name === 'foreignUuid' || name === 'foreignUlid') {
    if (!colName) return undefined;
    const type = name === 'foreignId' ? 'bigint' : name === 'foreignUuid' ? 'uuid' : 'ulid';
    return { columns: [mk(colName, type)], fk: { column: colName } };
  }
  if (name === 'foreignIdFor') {
    const model = first ? classRef(first) : undefined;
    if (!model) return undefined;
    const col = stringValue(def.args.positional[1]?.text) ?? `${snakeCase(model)}_id`;
    return { columns: [mk(col, 'bigint')], fk: { column: col, to: defaultTableName('laravel', model) } };
  }
  if (name === 'foreign') {
    if (!colName) return undefined;
    return { columns: [], fk: { column: colName } };
  }

  // polymorphic
  if (/^(morphs|nullableMorphs|uuidMorphs|ulidMorphs|nullableUuidMorphs)$/.test(name)) {
    if (!colName) return undefined;
    const nullable = /nullable/i.test(name);
    const idType = /uuid/i.test(name) ? 'uuid' : /ulid/i.test(name) ? 'ulid' : 'bigint';
    return {
      columns: [mk(`${colName}_id`, idType, { nullable }), mk(`${colName}_type`, 'string', { nullable })],
    };
  }

  // timestamps / soft deletes / token
  if (name === 'timestamps' || name === 'timestampsTz' || name === 'nullableTimestamps') {
    return { columns: [mk('created_at', 'timestamp', { nullable: true }), mk('updated_at', 'timestamp', { nullable: true })] };
  }
  if (name === 'softDeletes' || name === 'softDeletesTz') {
    return { columns: [mk(colName ?? 'deleted_at', 'timestamp', { nullable: true })] };
  }
  if (name === 'rememberToken') return { columns: [mk('remember_token', 'string', { nullable: true })] };

  // enum / set
  if (name === 'enum' || name === 'set') {
    if (!colName) return undefined;
    const values = listValues(def.args.positional[1]?.text ?? '');
    if (values.length) ctx.enums.push({ name: inlineEnumName(ctx.table, colName), values, source: ref });
    return { columns: [mk(colName, name, { enumRef: inlineEnumName(ctx.table, colName) })] };
  }

  const type = TYPES[name];
  if (type && colName) return { columns: [mk(colName, type)] };
  return undefined; // not a column-producing call (e.g. a raw statement)
}

function applyModifier(mod: Call, columns: Column[], fk: FkState | undefined): FkState | undefined {
  const target = columns[0];
  const argText = mod.args.positional[0]?.text;
  switch (mod.name) {
    case 'nullable': {
      const v = boolValue(argText);
      if (target) target.nullable = v !== false;
      break;
    }
    case 'default':
      if (target && argText !== undefined) target.default = stringValue(argText) ?? argText;
      break;
    case 'useCurrent':
      if (target) target.default = 'CURRENT_TIMESTAMP';
      break;
    case 'comment':
      if (target) target.comment = stringValue(argText);
      break;
    case 'unique':
      if (target) target.unique = true;
      break;
    case 'primary':
      if (target) {
        target.primaryKey = true;
        target.nullable = false;
      }
      break;
    case 'autoIncrement':
      if (target) target.generated = true;
      break;
    case 'storedAs':
    case 'virtualAs':
    case 'generatedAs':
      if (target) target.generated = true;
      break;
    case 'constrained':
      if (fk) {
        fk.to = stringValue(argText) ?? pluralize(fk.column.replace(/_id$/, ''));
        const col = stringValue(mod.args.positional[1]?.text);
        if (col) fk.toCol = col;
      }
      break;
    case 'references':
      if (fk) fk.toCol = stringValue(argText) ?? fk.toCol;
      break;
    case 'on':
      if (fk) fk.to = stringValue(argText) ?? fk.to;
      break;
    case 'cascadeOnDelete':
      if (fk) fk.onDelete = 'cascade';
      break;
    case 'restrictOnDelete':
      if (fk) fk.onDelete = 'restrict';
      break;
    case 'nullOnDelete':
      if (fk) fk.onDelete = 'set null';
      break;
    case 'noActionOnDelete':
      if (fk) fk.onDelete = 'no action';
      break;
    case 'cascadeOnUpdate':
      if (fk) fk.onUpdate = 'cascade';
      break;
    case 'restrictOnUpdate':
      if (fk) fk.onUpdate = 'restrict';
      break;
    case 'onDelete':
      if (fk) fk.onDelete = stringValue(argText) ?? fk.onDelete;
      break;
    case 'onUpdate':
      if (fk) fk.onUpdate = stringValue(argText) ?? fk.onUpdate;
      break;
    default:
      break;
  }
  return fk;
}

function patchOf(c: Column): ColumnPatch {
  const set: ColumnPatch = { type: c.type, nullable: c.nullable };
  if (c.default !== undefined) set.default = c.default;
  if (c.unique) set.unique = true;
  if (c.comment !== undefined) set.comment = c.comment;
  return set;
}

// ── Eloquent models ─────────────────────────────────────────────────────────────────────────

const RELATION_CALLS = /\$this\s*->\s*(belongsTo|hasMany|hasOne|belongsToMany)\s*\(/g;

function parseModels(file: SourceFile, code: Code): ParseResult {
  const m = code.masked;
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];

  const functions = [...m.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((fm) => ({ name: fm[1], at: fm.index! }));

  for (const cm of m.matchAll(/\bclass\s+(\w+)\s+extends\s+([\\\w]+)/g)) {
    const className = cm[1];
    const baseShort = shortName(cm[2]);
    const classAt = cm.index!;
    if (/\babstract\s+$/.test(m.slice(Math.max(0, classAt - 16), classAt))) continue;
    const braceOpen = m.indexOf('{', classAt);
    if (braceOpen < 0) continue;
    const braceClose = code.closing(braceOpen);
    const bodyEnd = braceClose < 0 ? code.text.length : braceClose;
    const body = m.slice(braceOpen, bodyEnd);

    const isModel =
      /^(Model|Authenticatable|Pivot|Eloquent)$/.test(baseShort) ||
      /\$this\s*->\s*(?:belongsTo|hasMany|hasOne|belongsToMany|morph)/.test(body) ||
      /protected\s+\$(?:table|fillable|guarded|casts)\b/.test(body);
    if (!isModel) continue;

    const tableMatch = /protected\s+\$table\s*=\s*(['"])([^'"]+)\1/.exec(code.stripped.slice(braceOpen, bodyEnd));
    const table = tableMatch ? tableMatch[2] : defaultTableName('laravel', className);
    const line = code.lineAt(classAt);

    entities.push({
      name: table,
      kind: 'table',
      modelName: className,
      nameCertainty: tableMatch ? 2 : 0,
      columns: [],
      source: sourceRef(file, line),
    });

    collectModelRelations(code, braceOpen, bodyEnd, table, className, functions, relations, file);
  }

  return { entities, relations, enums: [] };
}

function collectModelRelations(
  code: Code,
  start: number,
  end: number,
  table: string,
  model: string,
  functions: { name: string; at: number }[],
  relations: RawRelation[],
  file: SourceFile,
): void {
  const m = code.masked;
  for (const rm of m.slice(start, end).matchAll(RELATION_CALLS)) {
    const kind = rm[1];
    const at = start + rm.index!;
    const open = start + rm.index! + rm[0].length - 1;
    const args = code.args(open);
    const target = args.positional[0]?.text ? classRef(args.positional[0].text) : undefined;
    if (!target) continue;
    const method = enclosingFunction(functions, at);
    const ref = sourceRef(file, code.lineAt(at));
    const self: EntityRef = { name: table, model };
    const to: EntityRef = { model: target };

    if (kind === 'belongsTo') {
      const fk = stringValue(args.positional[1]?.text) ?? `${snakeCase(method ?? target)}_id`;
      const owner = stringValue(args.positional[2]?.text);
      relations.push({
        from: self,
        fromColumns: [fk],
        to,
        toColumns: owner ? [owner] : [],
        cardinality: 'many-to-one',
        kind: 'orm',
        source: ref,
      });
    } else if (kind === 'hasMany') {
      const fk = stringValue(args.positional[1]?.text) ?? `${snakeCase(model)}_id`;
      relations.push({ from: self, fromColumns: [], to, toColumns: [fk], cardinality: 'one-to-many', kind: 'orm', source: ref });
    } else if (kind === 'hasOne') {
      const fk = stringValue(args.positional[1]?.text) ?? `${snakeCase(model)}_id`;
      relations.push({ from: to, fromColumns: [fk], to: self, toColumns: [], cardinality: 'one-to-one', kind: 'orm', source: ref });
    } else if (kind === 'belongsToMany') {
      const pivot = stringValue(args.positional[1]?.text) ?? defaultPivot(model, target);
      relations.push({
        from: self,
        fromColumns: [],
        to,
        toColumns: [],
        cardinality: 'many-to-many',
        kind: 'orm',
        through: { name: pivot },
        source: ref,
      });
    }
  }
}

function enclosingFunction(functions: { name: string; at: number }[], at: number): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const f of functions) if (f.at < at && (!best || f.at > best.at)) best = f;
  return best?.name;
}

/** Default Laravel pivot table: the two model names, singular snake, sorted lexically. */
function defaultPivot(a: string, b: string): string {
  return [snakeCase(a), snakeCase(b)].sort().join('_');
}

/** Resolves `User::class`, `'App\\Models\\User'` or `App\\Models\\User::class` to a model short name. */
function classRef(text: string): string {
  const t = text.trim();
  const s = stringValue(t);
  if (s !== undefined) return shortName(s);
  const m = /^([\\\w]+)::class$/.exec(t);
  return shortName(m ? m[1] : t);
}

export const laravelParser: SchemaParser = {
  kind: 'laravel',
  extensions: ['.php'],
  detect,
  parse,
};
