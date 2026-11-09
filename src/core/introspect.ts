/**
 * Live database introspection: pure mapping from catalog rows to a `SchemaModel`.
 *
 * The drivers (src/extension/liveDb.ts) only run read-only catalog queries and hand the raw rows to
 * `introspectToModel()`, so the mapping is testable without a database and without VS Code.
 */
import type { Column, Entity, EngineId, IndexDef, Relation, SchemaModel } from './model';
import { entityId } from './resolve';

/** One row per column (`information_schema.columns` joined with the table type). */
export interface CatalogColumnRow {
  schema: string;
  table: string;
  name: string;
  type: string;
  nullable: boolean | string;
  default?: string | null;
  position: number;
  /** `BASE TABLE` / `VIEW` (anything containing VIEW is a view). */
  tableType?: string | null;
}

/** One row per constraint column; `position` is the 1-based column order inside the constraint. */
export interface CatalogConstraintRow {
  schema: string;
  table: string;
  name: string;
  /** `p`/`u`/`f` (PostgreSQL) or `PRIMARY KEY`/`UNIQUE`/`FOREIGN KEY` (information_schema). */
  type: string;
  column: string;
  position: number;
  refSchema?: string | null;
  refTable?: string | null;
  refColumn?: string | null;
}

export interface IntrospectInput {
  columns: readonly CatalogColumnRow[];
  constraints: readonly CatalogConstraintRow[];
  engine: Extract<EngineId, 'postgresql' | 'mysql'>;
  workspaceName: string;
  now?: Date;
}

type ConstraintKind = 'primary' | 'unique' | 'foreign' | undefined;

function kindOf(type: string): ConstraintKind {
  const t = type.trim().toUpperCase();
  if (t === 'P' || t === 'PRIMARY KEY') return 'primary';
  if (t === 'U' || t === 'UNIQUE') return 'unique';
  if (t === 'F' || t === 'FOREIGN KEY') return 'foreign';
  return undefined;
}

function isNullable(v: boolean | string): boolean {
  return typeof v === 'boolean' ? v : v.trim().toUpperCase() !== 'NO';
}

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

export function introspectToModel(input: IntrospectInput): SchemaModel {
  const entities = new Map<string, Entity>();
  const tableKey = (schema: string, table: string) => `${schema}\u0000${table}`;
  const idByTable = new Map<string, string>();

  for (const row of [...input.columns].sort(byPosition)) {
    const key = tableKey(row.schema, row.table);
    let entity = entities.get(key);
    if (!entity) {
      const kind = /VIEW/i.test(row.tableType ?? '') ? 'view' : 'table';
      const id = entityId(kind, row.schema, row.table);
      idByTable.set(key, id);
      entity = {
        id,
        name: row.table,
        schema: row.schema,
        kind,
        modelNames: [],
        columns: [],
        indexes: [],
        sources: [],
        files: [],
        engine: input.engine,
      };
      entities.set(key, entity);
    }
    const col: Column = {
      name: row.name,
      type: row.type.toLowerCase(),
      nullable: isNullable(row.nullable),
      primaryKey: false,
      unique: false,
    };
    if (row.default !== undefined && row.default !== null) col.default = String(row.default);
    entity.columns.push(col);
  }

  // Group constraint rows into constraints.
  const groups = new Map<string, CatalogConstraintRow[]>();
  for (const row of input.constraints) {
    if (!kindOf(row.type)) continue;
    const key = `${tableKey(row.schema, row.table)}\u0000${row.name}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const relations: Relation[] = [];
  // Primary/unique first so foreign keys can see the unique flag (one-to-one detection).
  const ordered = [...groups.values()].sort((a, b) => Number(kindOf(a[0].type) === 'foreign') - Number(kindOf(b[0].type) === 'foreign'));
  for (const rows of ordered) {
    rows.sort(byPosition);
    const first = rows[0];
    const kind = kindOf(first.type);
    const entity = entities.get(tableKey(first.schema, first.table));
    if (!entity) continue;
    const cols = rows.map((r) => r.column);
    const colDefs = cols.map((n) => entity.columns.find((c) => c.name === n));

    if (kind === 'primary') {
      for (const c of colDefs) if (c) c.primaryKey = true;
      if (cols.length === 1 && colDefs[0]) colDefs[0].unique = true;
    } else if (kind === 'unique') {
      const idx: IndexDef = { name: first.name, columns: cols, unique: true };
      entity.indexes.push(idx);
      if (cols.length === 1 && colDefs[0]) colDefs[0].unique = true;
    } else if (kind === 'foreign' && first.refTable) {
      const toId = idByTable.get(tableKey(first.refSchema ?? first.schema, first.refTable)) ?? entityId('table', first.refSchema ?? first.schema, first.refTable);
      const toCols = rows.map((r) => r.refColumn ?? '');
      const unique = cols.length === 1 && !!colDefs[0]?.unique;
      relations.push({
        id: `${entity.id}(${cols.join(',')})->${toId}`,
        from: entity.id,
        fromColumns: cols,
        to: toId,
        toColumns: toCols,
        cardinality: unique ? 'one-to-one' : 'many-to-one',
        kind: 'foreign-key',
        optional: colDefs.some((c) => c?.nullable !== false),
        name: first.name,
        sources: [],
      });
      if (cols.length === 1 && colDefs[0]) colDefs[0].references = { entity: toId, column: toCols[0] };
    }
  }

  const list = [...entities.values()].sort((a, b) => a.id.localeCompare(b.id));
  relations.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    workspaceName: input.workspaceName,
    entities: list,
    relations,
    enums: [],
    engines: [],
    sources: [],
    warnings: [],
    stats: { filesFound: 0, filesRead: 0, filesParsed: 0, durationMs: 0, truncated: false },
  };
}
