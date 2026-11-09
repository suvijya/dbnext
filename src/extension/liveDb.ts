import * as vscode from 'vscode';
import { Client } from 'pg';
import { createConnection } from 'mysql2/promise';
import type { CatalogColumnRow, CatalogConstraintRow } from '../core/introspect';

/**
 * Read-only catalog access for dbnext.liveDatabase.* (desktop host only; swapped for a stub in the web build).
 * Only SELECTs on the system catalogs are issued, inside sessions that are switched to read-only mode.
 * The password lives in SecretStorage and is never written to settings or logs.
 */
export interface LiveConnection {
  engine: 'postgresql' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
}

export interface CatalogRows {
  columns: CatalogColumnRow[];
  constraints: CatalogConstraintRow[];
}

const SYSTEM_SCHEMAS = "('pg_catalog','information_schema','pg_toast')";

const PG_COLUMNS = `SELECT c.table_schema AS "schema", c.table_name AS "table", c.column_name AS "name", c.data_type AS "type",
  c.is_nullable AS "nullable", c.column_default AS "default", c.ordinal_position AS "position", t.table_type AS "tableType"
  FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema NOT IN ${SYSTEM_SCHEMAS}`;

const PG_CONSTRAINTS = `SELECT n.nspname AS "schema", cl.relname AS "table", con.conname AS "name", con.contype::text AS "type",
  a.attname AS "column", k.ord::int AS "position", rn.nspname AS "refSchema", rcl.relname AS "refTable", ra.attname AS "refColumn"
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
  LEFT JOIN pg_class rcl ON rcl.oid = con.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
  LEFT JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[k.ord]
  WHERE con.contype IN ('p','u','f') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`;

const MY_COLUMNS = `SELECT c.table_schema AS \`schema\`, c.table_name AS \`table\`, c.column_name AS \`name\`, c.column_type AS \`type\`,
  c.is_nullable AS \`nullable\`, c.column_default AS \`default\`, c.ordinal_position AS \`position\`, t.table_type AS \`tableType\`
  FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = DATABASE()`;

const MY_CONSTRAINTS = `SELECT kcu.table_schema AS \`schema\`, kcu.table_name AS \`table\`, kcu.constraint_name AS \`name\`, tc.constraint_type AS \`type\`,
  kcu.column_name AS \`column\`, kcu.ordinal_position AS \`position\`, kcu.referenced_table_schema AS \`refSchema\`,
  kcu.referenced_table_name AS \`refTable\`, kcu.referenced_column_name AS \`refColumn\`
  FROM information_schema.key_column_usage kcu
  JOIN information_schema.table_constraints tc ON tc.constraint_schema = kcu.constraint_schema AND tc.table_name = kcu.table_name AND tc.constraint_name = kcu.constraint_name
  WHERE kcu.table_schema = DATABASE() AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE','FOREIGN KEY')`;

export function readLiveConnection(): LiveConnection | undefined {
  const c = vscode.workspace.getConfiguration('dbnext.liveDatabase');
  const engine = c.get<string>('engine') === 'mysql' ? 'mysql' : 'postgresql';
  const database = (c.get<string>('database') ?? '').trim();
  const user = (c.get<string>('user') ?? '').trim();
  if (!database || !user) return undefined;
  const port = Number(c.get('port')) || (engine === 'mysql' ? 3306 : 5432);
  return { engine, host: (c.get<string>('host') ?? 'localhost').trim() || 'localhost', port, database, user };
}

function secretKey(c: LiveConnection): string {
  return `dbnext.liveDatabase.password:${c.engine}:${c.user}@${c.host}:${c.port}/${c.database}`;
}

export async function clearPassword(secrets: vscode.SecretStorage, c: LiveConnection): Promise<void> {
  await secrets.delete(secretKey(c));
}

async function passwordFor(secrets: vscode.SecretStorage, c: LiveConnection): Promise<string | undefined> {
  const key = secretKey(c);
  const stored = await secrets.get(key);
  if (stored !== undefined) return stored;
  const entered = await vscode.window.showInputBox({ prompt: `Password for ${c.user}@${c.host}:${c.port}/${c.database} (stored in VS Code SecretStorage)`, password: true, ignoreFocusOut: true });
  if (entered === undefined) return undefined;
  await secrets.store(key, entered);
  return entered;
}

/** Runs the read-only catalog queries. Returns undefined when the user cancels the password prompt. */
export async function fetchCatalog(secrets: vscode.SecretStorage, c: LiveConnection): Promise<CatalogRows | undefined> {
  const password = await passwordFor(secrets, c);
  if (password === undefined) return undefined;
  if (c.engine === 'postgresql') {
    const client = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password, connectionTimeoutMillis: 10000, options: '-c default_transaction_read_only=on' });
    await client.connect();
    try {
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      const columns = await client.query(PG_COLUMNS);
      const constraints = await client.query(PG_CONSTRAINTS);
      return { columns: columns.rows as CatalogColumnRow[], constraints: constraints.rows as CatalogConstraintRow[] };
    } finally {
      await client.end();
    }
  }
  const conn = await createConnection({ host: c.host, port: c.port, database: c.database, user: c.user, password, connectTimeout: 10000 });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    const [columns] = await conn.query(MY_COLUMNS);
    const [constraints] = await conn.query(MY_CONSTRAINTS);
    return { columns: columns as CatalogColumnRow[], constraints: constraints as CatalogConstraintRow[] };
  } finally {
    await conn.end();
  }
}
