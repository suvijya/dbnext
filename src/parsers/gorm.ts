/**
 * GORM (Go) schema parser — `gorm.io/gorm` / `jinzhu/gorm`.
 *
 * Reads Go structs that are GORM models: fields become columns (snake_case names, `gorm:"…"` tag
 * overrides), embedded `gorm.Model` expands to `id/created_at/updated_at/deleted_at`, and association
 * fields (belongs-to / has-one / has-many / many2many) become relations. The table name follows the
 * `pluralize(snake(Struct))` convention unless a `TableName()` method sets it explicitly.
 */

import {
  type Column,
  type ParseResult,
  type RawEntity,
  type RawRelation,
  type SourceFile,
} from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, shortName, snakeCase } from '../core/naming';
import { Code, cleanComment, stringValue } from '../core/text';
import {
  GO_BUILTIN_TYPES,
  goMethods,
  goStructFields,
  goStructs,
  isGoScalarType,
  parseStructTag,
  splitEscaped,
  splitTopLevel,
  type GoField,
  type GoStruct,
} from './shared/gorust';

interface GormSettings {
  flags: Set<string>;
  values: Map<string, string>;
}

function gormSettings(value: string | undefined): GormSettings {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  if (value) {
    for (const raw of splitEscaped(value, ';')) {
      const part = raw.trim();
      if (!part) continue;
      const colon = part.indexOf(':');
      if (colon < 0) flags.add(part.toLowerCase());
      else values.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
    }
  }
  return { flags, values };
}

function gormTagOf(field: GoField): string | undefined {
  return parseStructTag(field.tag).get('gorm');
}

/**
 * A `gorm:"-"` or `gorm:"-:all"` tag ignores the field entirely (no column, no relation).
 * `gorm:"-:migration"` only skips auto-migration, so the field stays a column.
 */
function isGormIgnored(gorm: string | undefined): boolean {
  if (gorm === undefined) return false;
  const first = splitEscaped(gorm, ';')[0]?.trim();
  return first === '-' || first === '-:all';
}

function parseConstraint(value: string | undefined): { onDelete?: string; onUpdate?: string } {
  const out: { onDelete?: string; onUpdate?: string } = {};
  if (!value) return out;
  for (const part of splitTopLevel(value, ',')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim();
    if (key === 'ondelete') out.onDelete = val;
    else if (key === 'onupdate') out.onUpdate = val;
  }
  return out;
}

const SQL_NULL_RE = /^sql\.Null/;

function gormModelColumns(prefix: string, line: number, file: string): Column[] {
  const n = (name: string) => prefix + name;
  const at = { file, line };
  return [
    column(n('id'), 'uint', { primaryKey: true, nullable: false, generated: true, source: at }),
    column(n('created_at'), 'time.Time', { nullable: false, source: at }),
    column(n('updated_at'), 'time.Time', { nullable: false, source: at }),
    column(n('deleted_at'), 'gorm.DeletedAt', { nullable: true, source: at }),
  ];
}

/** Packages whose exported types are column values (time.Time, sql.NullString, uuid.UUID…), never models. */
const VALUE_PACKAGES = new Set([
  'time', 'sql', 'driver', 'uuid', 'datatypes', 'decimal', 'json', 'pq', 'null', 'nulls', 'zero', 'gorm',
  'pgtype', 'types', 'big', 'net', 'netip', 'xid', 'ulid', 'primitive', 'bson', 'civil', 'mysql', 'geom', 'orb',
  'money', 'pgvector', 'ksuid', 'shortuuid', 'carbon', 'hstore',
]);

/**
 * Is this named field an association (another model) rather than a scalar column?
 * `siblings` = all field names of the struct (a belongs-to FK field may come after the association).
 */
function isAssociation(field: GoField, settings: GormSettings, siblings?: ReadonlySet<string>): boolean {
  if (settings.values.has('many2many') || settings.values.has('foreignkey') || settings.values.has('references') || settings.values.has('polymorphic')) {
    return true;
  }
  const dot = field.type.lastIndexOf('.');
  if (dot > 0 && !field.type.startsWith('map[')) {
    // Model from another package (`users.UserModel`): only with clear evidence.
    const pkg = field.type.slice(0, dot);
    const name = field.type.slice(dot + 1);
    if (!/^[A-Z]/.test(name) || VALUE_PACKAGES.has(pkg)) return false;
    const fieldName = field.names[0];
    if (siblings && fieldName && (siblings.has(`${fieldName}ID`) || siblings.has(`${name}ID`))) return true; // belongs-to
    return field.isArray; // has-many
  }
  if (isGoScalarType({ pointer: field.pointer, isArray: field.isArray, base: field.type })) return false;
  // A capitalised, unqualified, non-builtin type (optionally a slice) is a model reference.
  return /^[A-Z]/.test(field.type) && !GO_BUILTIN_TYPES.has(field.type);
}

interface BuiltStruct {
  columns: Column[];
  scalarFieldNames: Set<string>;
}

function buildColumns(
  code: Code,
  file: string,
  struct: GoStruct,
  structMap: Map<string, GoStruct>,
  prefix: string,
  visited: Set<string>,
): BuiltStruct {
  const columns: Column[] = [];
  const scalarFieldNames = new Set<string>();
  const add = (c: Column) => {
    if (!columns.some((x) => x.name === c.name)) columns.push(c);
  };

  const fields = goStructFields(code, struct.open);
  const siblings = new Set(fields.flatMap((f) => f.names));
  for (const field of fields) {
    const gorm = gormTagOf(field);
    if (isGormIgnored(gorm)) continue;
    const settings = gormSettings(gorm);

    if (field.embedded) {
      if (field.type === 'gorm.Model') {
        for (const c of gormModelColumns(prefix, field.line, file)) add(c);
        continue;
      }
      const embeddedPrefix = settings.values.get('embeddedprefix') ?? '';
      const inner = structMap.get(field.type) ?? structMap.get(shortName(field.type));
      if (inner && !visited.has(inner.name)) {
        const built = buildColumns(code, file, inner, structMap, prefix + embeddedPrefix, new Set([...visited, struct.name]));
        for (const c of built.columns) add(c);
      }
      continue;
    }

    if (isAssociation(field, settings, siblings)) continue;

    for (const fieldName of field.names) {
      scalarFieldNames.add(fieldName);
      add(buildScalarColumn(fieldName, field, settings, prefix, file));
    }
  }
  return { columns, scalarFieldNames };
}

function buildScalarColumn(fieldName: string, field: GoField, settings: GormSettings, prefix: string, file: string): Column {
  const { flags, values } = settings;
  const base = field.type;
  const name = (values.get('column') ?? prefix + snakeCase(fieldName)).trim();
  const primaryKey = (fieldName === 'ID' && prefix === '') || flags.has('primarykey');

  let type = values.get('type') ?? '';
  if (!type) {
    const size = values.get('size');
    type = base === 'string' && size ? `varchar(${size})` : base;
  }

  let nullable: boolean;
  if (flags.has('not null') || flags.has('notnull') || primaryKey) nullable = false;
  else if (field.pointer || SQL_NULL_RE.test(base) || base === 'gorm.DeletedAt') nullable = true;
  else nullable = base === 'string'; // GORM leaves text columns nullable; other value types are NOT NULL

  const generated = flags.has('autoincrement') || flags.has('autocreatetime') || flags.has('autoupdatetime');
  const unique = flags.has('unique') || flags.has('uniqueindex') || values.has('uniqueindex');
  const props: Partial<Column> = { nullable, primaryKey, unique, source: { file, line: field.line } };
  if (generated) props.generated = true;
  if (values.has('default')) props.default = values.get('default');
  if (values.has('comment')) props.comment = values.get('comment');
  if (field.isArray && base !== 'byte') props.isArray = true;
  return column(name, type, props);
}

function buildRelations(file: string, struct: GoStruct, fields: GoField[], scalarFieldNames: Set<string>): RawRelation[] {
  const out: RawRelation[] = [];
  const siblings = new Set(fields.flatMap((f) => f.names));
  for (const field of fields) {
    if (field.embedded || !field.names.length) continue;
    const gorm = gormTagOf(field);
    if (isGormIgnored(gorm)) continue;
    const settings = gormSettings(gorm);
    if (!isAssociation(field, settings, siblings)) continue;

    const assoc = shortName(field.type); // `users.UserModel` → `UserModel`
    const fieldName = field.names[0];
    const { onDelete, onUpdate } = parseConstraint(settings.values.get('constraint'));
    const src = sourceRef(file, field.line);
    const extra: { onDelete?: string; onUpdate?: string } = {};
    if (onDelete) extra.onDelete = onDelete;
    if (onUpdate) extra.onUpdate = onUpdate;

    const many2many = settings.values.get('many2many');
    if (many2many) {
      out.push({ from: { model: struct.name }, fromColumns: [], to: { model: assoc }, toColumns: [], cardinality: 'many-to-many', through: { name: many2many }, kind: 'orm', source: src, ...extra });
      continue;
    }

    const references = settings.values.get('references');
    const refCols = references ? [snakeCase(references)] : [];

    // Polymorphic association: the child holds `<Poly>ID` / `<Poly>Type` columns (default prefix
    // `Owner`), shared by every parent type. The real FK column is `<poly>_id`, never `<parent>_id`.
    const polymorphic = settings.values.get('polymorphic');
    if (polymorphic) {
      const fkCol = snakeCase(`${polymorphic}ID`);
      if (field.isArray) {
        out.push({ from: { model: struct.name }, fromColumns: refCols, to: { model: assoc }, toColumns: [fkCol], cardinality: 'one-to-many', kind: 'orm', source: src, ...extra });
      } else {
        out.push({ from: { model: assoc }, fromColumns: [fkCol], to: { model: struct.name }, toColumns: refCols, cardinality: 'one-to-one', kind: 'orm', source: src, ...extra });
      }
      continue;
    }

    if (field.isArray) {
      const fkField = settings.values.get('foreignkey') ?? `${struct.name}ID`;
      out.push({ from: { model: struct.name }, fromColumns: refCols, to: { model: assoc }, toColumns: [snakeCase(fkField)], cardinality: 'one-to-many', kind: 'orm', source: src, ...extra });
      continue;
    }

    const tagFk = settings.values.get('foreignkey');
    const localFk = tagFk ?? `${fieldName}ID`;
    const belongsTo = scalarFieldNames.has(localFk) || scalarFieldNames.has(`${fieldName}ID`) || scalarFieldNames.has(`${assoc}ID`);
    if (belongsTo) {
      const fkField = tagFk ?? (scalarFieldNames.has(`${fieldName}ID`) ? `${fieldName}ID` : `${assoc}ID`);
      out.push({ from: { model: struct.name }, fromColumns: [snakeCase(fkField)], to: { model: assoc }, toColumns: refCols, cardinality: 'many-to-one', kind: 'orm', source: src, ...extra });
    } else {
      const fkField = tagFk ?? `${struct.name}ID`;
      out.push({ from: { model: assoc }, fromColumns: [snakeCase(fkField)], to: { model: struct.name }, toColumns: refCols, cardinality: 'one-to-one', kind: 'orm', source: src, ...extra });
    }
  }
  return out;
}

const TABLE_NAME_RE = /return\s+("(?:[^"\\]|\\.)*"|`[^`]*`)/;

/** Receiver → explicit table name from `func (X) TableName() string { return "…" }`. */
function tableNames(code: Code): Map<string, string> {
  const out = new Map<string, string>();
  for (const method of goMethods(code)) {
    if (method.name !== 'TableName') continue;
    const body = code.stripped.slice(method.open, method.close);
    const m = TABLE_NAME_RE.exec(body);
    const value = m ? stringValue(m[1]) : undefined;
    if (value) out.set(method.recv, value);
  }
  return out;
}

const AUTOMIGRATE_RE = /\.AutoMigrate\s*\(/g;
const MODEL_ARG_RE = /&?\s*(?:\w+\.)?(\w+)\s*\{/;

/** Model names confirmed by `db.AutoMigrate(&User{}, &Product{})`. */
function autoMigrated(code: Code): string[] {
  const out: string[] = [];
  const masked = code.masked;
  for (const match of masked.matchAll(AUTOMIGRATE_RE)) {
    const open = match.index + match[0].length - 1;
    for (const item of code.items(open)) {
      const m = MODEL_ARG_RE.exec(item.text);
      if (m && /^[A-Z]/.test(m[1])) out.push(m[1]);
    }
  }
  return out;
}

function importsGorm(text: string): boolean {
  return text.includes('gorm.io/gorm') || text.includes('jinzhu/gorm');
}

function detect(file: SourceFile): boolean {
  const t = file.text;
  return importsGorm(t) || /`[^`]*\bgorm:"/.test(t);
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'go');
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  const structs = goStructs(code);
  const structMap = new Map<string, GoStruct>(structs.map((s) => [s.name, s]));
  const names = tableNames(code);
  const gormFile = importsGorm(file.text);
  const defined = new Set<string>();

  for (const struct of structs) {
    const fields = goStructFields(code, struct.open);
    const hasGormModel = fields.some((f) => f.embedded && f.type === 'gorm.Model');
    const hasGormTags = fields.some((f) => parseStructTag(f.tag).has('gorm'));
    const isModel = hasGormModel || hasGormTags || names.has(struct.name);
    if (!isModel && !(gormFile && struct.exported)) continue;

    const explicit = names.get(struct.name);
    const { columns, scalarFieldNames } = buildColumns(code, file.path, struct, structMap, '', new Set());
    const entity: RawEntity = {
      name: explicit ?? defaultTableName('gorm', struct.name),
      kind: 'table',
      modelName: struct.name,
      nameCertainty: explicit ? 2 : 0,
      columns,
      source: sourceRef(file, struct.line),
    };
    if (!isModel) entity.candidate = true;
    const comment = cleanComment(code.leadingComments(code.lineStart(struct.line)).join('\n'));
    if (comment) entity.comment = comment;
    entities.push(entity);
    defined.add(struct.name);

    for (const rel of buildRelations(file.path, struct, fields, scalarFieldNames)) relations.push(rel);
  }

  // TableName() for a struct defined in another file → partial entity carrying the explicit name.
  for (const [recv, name] of names) {
    if (defined.has(recv)) continue;
    entities.push({ name, kind: 'table', modelName: recv, nameCertainty: 2, columns: [], partial: true, source: sourceRef(file, 0) });
  }

  // AutoMigrate confirms models (any file) with a partial, non-candidate entity.
  for (const model of new Set(autoMigrated(code))) {
    if (defined.has(model)) continue;
    const explicit = names.get(model);
    entities.push({
      name: explicit ?? defaultTableName('gorm', model),
      kind: 'table',
      modelName: model,
      nameCertainty: explicit ? 2 : 0,
      columns: [],
      partial: true,
      source: sourceRef(file, 0),
    });
  }

  return { entities, relations, enums: [] };
}

export const gormParser: SchemaParser = {
  kind: 'gorm',
  extensions: ['.go'],
  detect,
  parse,
};
