/**
 * DBNext core data model.
 *
 * Parsers turn one source file into a `ParseResult` made of *raw* entities and relations whose
 * references are still unresolved (they point at table or model names). `resolveSchema()` merges
 * the results of every file into a single `SchemaModel` that the tree view, the webview and the
 * Markdown exporter consume.
 *
 * This module only contains types and small constant tables, so it can be imported from the
 * extension host (Node or browser) and from the webview bundle alike.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sources (technologies a schema can be read from) and database engines
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SOURCE_KINDS = [
  'sql',
  'dbml',
  'diesel',
  'prisma',
  'typeorm',
  'mikroorm',
  'drizzle',
  'sequelize',
  'mongoose',
  'knex',
  'kysely',
  'django',
  'sqlalchemy',
  'sqlmodel',
  'rails',
  'laravel',
  'doctrine',
  'gorm',
  'jpa',
  'efcore',
  'ecto',
] as const;

/** Technology a schema definition was read from. Also used by the `dbnext.disabledSources` setting. */
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  sql: 'SQL',
  dbml: 'DBML',
  diesel: 'Diesel',
  prisma: 'Prisma',
  typeorm: 'TypeORM',
  mikroorm: 'MikroORM',
  drizzle: 'Drizzle',
  sequelize: 'Sequelize',
  mongoose: 'Mongoose',
  knex: 'Knex',
  kysely: 'Kysely',
  django: 'Django',
  sqlalchemy: 'SQLAlchemy',
  sqlmodel: 'SQLModel',
  rails: 'Rails',
  laravel: 'Laravel',
  doctrine: 'Doctrine',
  gorm: 'GORM',
  jpa: 'JPA / Hibernate',
  efcore: 'EF Core',
  ecto: 'Ecto',
};

export const ENGINE_IDS = [
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sqlserver',
  'oracle',
  'cockroachdb',
  'h2',
  'mongodb',
  'redis',
  'cassandra',
  'dynamodb',
  'firestore',
  'cosmosdb',
  'neo4j',
  'elasticsearch',
  'clickhouse',
  'duckdb',
  'snowflake',
  'bigquery',
] as const;

/** A database management system the project uses. */
export type EngineId = (typeof ENGINE_IDS)[number];

export type EngineCategory =
  | 'relational'
  | 'document'
  | 'key-value'
  | 'wide-column'
  | 'graph'
  | 'search'
  | 'analytics';

export const ENGINES: Readonly<Record<EngineId, { label: string; category: EngineCategory }>> = {
  postgresql: { label: 'PostgreSQL', category: 'relational' },
  mysql: { label: 'MySQL', category: 'relational' },
  mariadb: { label: 'MariaDB', category: 'relational' },
  sqlite: { label: 'SQLite', category: 'relational' },
  sqlserver: { label: 'SQL Server', category: 'relational' },
  oracle: { label: 'Oracle', category: 'relational' },
  cockroachdb: { label: 'CockroachDB', category: 'relational' },
  h2: { label: 'H2', category: 'relational' },
  mongodb: { label: 'MongoDB', category: 'document' },
  redis: { label: 'Redis', category: 'key-value' },
  cassandra: { label: 'Cassandra', category: 'wide-column' },
  dynamodb: { label: 'DynamoDB', category: 'key-value' },
  firestore: { label: 'Firestore', category: 'document' },
  cosmosdb: { label: 'Cosmos DB', category: 'document' },
  neo4j: { label: 'Neo4j', category: 'graph' },
  elasticsearch: { label: 'Elasticsearch', category: 'search' },
  clickhouse: { label: 'ClickHouse', category: 'analytics' },
  duckdb: { label: 'DuckDB', category: 'analytics' },
  snowflake: { label: 'Snowflake', category: 'analytics' },
  bigquery: { label: 'BigQuery', category: 'analytics' },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Files and locations
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceFile {
  /**
   * Workspace-relative path using forward slashes, e.g. `prisma/schema.prisma`.
   * In multi-root workspaces it is prefixed with the workspace folder name.
   */
  path: string;
  /** Full UTF-8 text of the file. */
  text: string;
}

export interface SourceRef {
  /** Same value as `SourceFile.path`. */
  file: string;
  /** 0-based line number. */
  line: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolved model (output of resolveSchema / buildModel)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ColumnRef {
  /** Referenced entity id. */
  entity: string;
  /** Referenced column name, when known. */
  column?: string;
  /** The reference was guessed from naming conventions. */
  inferred?: boolean;
}

export interface Column {
  /** Column / field name as stored in the database (ORM column-name mappings applied when known). */
  name: string;
  /** Data type as written in the source, lightly normalised (`varchar(255)`, `Int`, `ObjectId`…). `''` when unknown. */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** Value produced by the database / ORM: serial, identity, auto-increment, generated uuid… */
  generated?: boolean;
  /** Default value expression as written in the source. */
  default?: string;
  comment?: string;
  /** The column stores a list / array of values. */
  isArray?: boolean;
  source?: SourceRef;
  /** Set by the resolver: id of the enum this column's type refers to. */
  enumRef?: string;
  /** Set by the resolver: what this column points to when it is (part of) a foreign key. */
  references?: ColumnRef;
}

export interface IndexDef {
  name?: string;
  columns: string[];
  unique: boolean;
  source?: SourceRef;
}

export interface EnumDef {
  /** Unique id (lower-case), e.g. `role` or `auth.role`. */
  id: string;
  name: string;
  schema?: string;
  values: string[];
  sources: SourceKind[];
  source?: SourceRef;
}

export type EntityKind = 'table' | 'view' | 'collection';

export interface Entity {
  /** Unique, stable id (lower-case): `users`, `auth.users`, `doc:users` for document collections. */
  id: string;
  name: string;
  /** Non-default schema / namespace (`public`, `dbo` and `main` are omitted). */
  schema?: string;
  kind: EntityKind;
  /** ORM model / class names mapped to this entity. */
  modelNames: string[];
  columns: Column[];
  indexes: IndexDef[];
  comment?: string;
  /** Technologies that contributed to this entity. */
  sources: SourceKind[];
  /** Primary definition, used for "Go to definition". */
  source?: SourceRef;
  /** Every file that contributes to this entity. */
  files: string[];
  engine?: EngineId;
  /** Optional grouping label (Django app, module…). */
  group?: string;
  /** Referenced by a relation but not defined in the workspace (e.g. a framework's built-in user table). */
  external?: boolean;
  /** Pure junction table of a many-to-many relationship (set by the resolver). */
  joinTable?: boolean;
}

export type Cardinality = 'many-to-one' | 'one-to-one' | 'many-to-many';

/**
 * - `foreign-key`: declared database constraint (DDL, migrations, schema files)
 * - `orm`: association declared in ORM code
 * - `inferred`: guessed from naming conventions such as `user_id` → `users.id`
 */
export type RelationKind = 'foreign-key' | 'orm' | 'inferred';

export interface Relation {
  id: string;
  /** Entity holding the foreign key (for many-to-many: one of the two sides). */
  from: string;
  fromColumns: string[];
  /** Referenced entity. */
  to: string;
  toColumns: string[];
  cardinality: Cardinality;
  kind: RelationKind;
  /** The foreign key may be NULL, i.e. a `from` row can exist without a `to` row. */
  optional: boolean;
  name?: string;
  onDelete?: string;
  onUpdate?: string;
  /** Many-to-many only: id of the join entity when it exists in the model. */
  through?: string;
  /** Many-to-many only: join table name as declared (display purposes). */
  throughName?: string;
  sources: SourceKind[];
  source?: SourceRef;
}

export interface EngineEvidence {
  file: string;
  line: number;
  /** Human readable reason, e.g. `docker compose image "postgres:16"`. */
  detail: string;
}

export interface EngineInfo {
  id: EngineId;
  label: string;
  category: EngineCategory;
  evidence: EngineEvidence[];
}

export interface SourceSummary {
  kind: SourceKind;
  label: string;
  files: number;
  entities: number;
}

export interface ScanWarning {
  file?: string;
  line?: number;
  message: string;
}

export interface ScanStats {
  /** Candidate files found by the file search. */
  filesFound: number;
  /** Files actually read. */
  filesRead: number;
  /** Files that at least one parser produced output for. */
  filesParsed: number;
  durationMs: number;
  /** The `dbnext.maxFiles` limit was hit. */
  truncated: boolean;
}

export interface SchemaModel {
  version: 1;
  /** ISO timestamp. */
  generatedAt: string;
  workspaceName: string;
  entities: Entity[];
  relations: Relation[];
  enums: EnumDef[];
  engines: EngineInfo[];
  sources: SourceSummary[];
  warnings: ScanWarning[];
  stats: ScanStats;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Raw parser output (input of resolveSchema)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Unresolved pointer to an entity. Give as much as is known; the resolver tries `name`, then `model`. */
export interface EntityRef {
  /** Table / collection name. */
  name?: string;
  /** ORM model / class name (matched against `RawEntity.modelName`). */
  model?: string;
  schema?: string;
}

export interface RawEntity {
  /** Table / collection name. For ORMs apply the ORM's default naming convention when not configured. */
  name: string;
  schema?: string;
  kind: EntityKind;
  /** ORM model / class name. */
  modelName?: string;
  /**
   * How certain `name` is. When several raw entities of the same source kind share a `modelName`,
   * the most certain name wins for all of them. Defaults to 2.
   *  - 0: derived from the class / model name by the ORM's default naming convention
   *  - 1: derived from secondary configuration (e.g. EF Core `DbSet<Blog> Blogs`)
   *  - 2: explicitly configured (`@Table(name=…)`, `__tablename__`, `@@map`, `$table`, DDL…)
   */
  nameCertainty?: 0 | 1 | 2;
  columns: Column[];
  indexes?: IndexDef[];
  comment?: string;
  source: SourceRef;
  engine?: EngineId;
  group?: string;
  /** Only adds to an entity defined elsewhere (e.g. `ALTER TABLE … ADD COLUMN`, Rails `add_column`). */
  partial?: boolean;
  /** Abstract base / mixin / mapped superclass: not a table itself, its columns are inherited. */
  abstract?: boolean;
  /** Base class / model names. Columns of *abstract* bases are copied into this entity. */
  extends?: string[];
}

export interface RawRelation {
  from: EntityRef;
  /** Columns of `from` that hold the foreign key. May be empty when unknown (the resolver guesses). */
  fromColumns: string[];
  to: EntityRef;
  /** Referenced columns of `to`. May be empty (the resolver uses the primary key). */
  toColumns: string[];
  /** `one-to-many` is accepted for convenience and flipped into `many-to-one` by the resolver. */
  cardinality: Cardinality | 'one-to-many';
  kind: 'foreign-key' | 'orm';
  name?: string;
  onDelete?: string;
  onUpdate?: string;
  /** Many-to-many join table / model. */
  through?: EntityRef;
  /** The foreign key is nullable. When omitted it is derived from the `from` columns. */
  optional?: boolean;
  source: SourceRef;
}

export interface RawEnum {
  name: string;
  schema?: string;
  values: string[];
  /** Only appends values to an enum defined elsewhere (e.g. `ALTER TYPE … ADD VALUE`). */
  partial?: boolean;
  source: SourceRef;
}

/** Attributes an `alterColumn` operation can change. Omitted attributes are left untouched. */
export type ColumnPatch = Partial<
  Pick<Column, 'type' | 'nullable' | 'primaryKey' | 'unique' | 'generated' | 'default' | 'comment' | 'isArray'>
>;

/**
 * Schema changes found in migrations / DDL, applied in file order and, inside a file, in line order
 * (together with the entities, relations and enums of the same file).
 * Adding columns is expressed with a `partial` RawEntity instead of an op.
 */
export type SchemaOp =
  | { op: 'dropTable'; table: EntityRef; source: SourceRef }
  | { op: 'renameTable'; table: EntityRef; to: string; source: SourceRef }
  | { op: 'dropColumn'; table: EntityRef; column: string; source: SourceRef }
  | { op: 'renameColumn'; table: EntityRef; column: string; to: string; source: SourceRef }
  | { op: 'alterColumn'; table: EntityRef; column: string; set: ColumnPatch; source: SourceRef }
  /** Removes foreign keys of `table`, matched by constraint `name`, by `columns`, or by target `to`. */
  | { op: 'dropForeignKey'; table: EntityRef; name?: string; columns?: string[]; to?: EntityRef; source: SourceRef };

export interface EngineHint {
  engine: EngineId;
  /** 0-based line. */
  line: number;
  detail: string;
}

export interface ParseResult {
  /**
   * `definition`: describes the current schema (ORM models, schema.prisma, schema.rb, schema dumps…).
   * `migration`: part of a chronological history (migration files). Definitions win when both describe
   * the same entity; migrations are replayed in path order. Defaults to `definition`.
   */
  origin?: 'definition' | 'migration';
  entities: RawEntity[];
  relations: RawRelation[];
  enums: RawEnum[];
  ops?: SchemaOp[];
  /**
   * Explicit ordering for migration systems whose file names do not sort chronologically
   * (Alembic `revision` / `down_revision`). `after` lists the ids of the parent migrations.
   * Migrations without this info are replayed in natural path order.
   */
  migration?: { id: string; after: string[] };
  /** Database engines that can be deduced from this file (Prisma provider, `pgTable`, Mongoose…). */
  engines?: EngineHint[];
  warnings?: { line?: number; message: string }[];
}

/** A parse result tagged with the file and parser it came from. */
export interface FileResult {
  file: string;
  kind: SourceKind;
  result: ParseResult;
}

/** Creates an empty parse result. */
export function emptyResult(origin: ParseResult['origin'] = 'definition'): ParseResult {
  return { origin, entities: [], relations: [], enums: [] };
}
