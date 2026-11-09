/** Web build replacement for liveDb.ts: live database access needs the desktop extension host. */
import type * as vscode from 'vscode';
import type { CatalogColumnRow, CatalogConstraintRow } from '../core/introspect';

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

export function readLiveConnection(): LiveConnection | undefined {
  return undefined;
}

export async function clearPassword(_secrets: vscode.SecretStorage, _c: LiveConnection): Promise<void> {}

export async function fetchCatalog(_secrets: vscode.SecretStorage, _c: LiveConnection): Promise<CatalogRows | undefined> {
  throw new Error('Live database introspection is only available in the desktop version of VS Code.');
}
