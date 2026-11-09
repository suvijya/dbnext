/**
 * Messages exchanged between the extension host and the DB Map webview (via postMessage).
 * Dependency-free: safe to import from both sides.
 */

import type { SchemaDiff } from './diff';
import type { SchemaModel, SourceRef } from './model';
import type { Notes } from './notes';
import type { SavedView } from './views';

export interface NodePosition {
  x: number;
  y: number;
}

/** Entity id → top-left position of nodes the user moved by hand. Persisted per workspace. */
export type Layout = Record<string, NodePosition>;

const MAX_LAYOUT_ENTRIES = 20_000;

/** Accepts only `{ [entityId]: { x, y } }` with finite numbers; anything else is dropped. */
export function sanitizeLayout(value: unknown): Layout | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Layout = {};
  let n = 0;
  for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_LAYOUT_ENTRIES) break;
    const p = pos as { x?: unknown; y?: unknown } | null;
    if (id.length > 1000 || !p || typeof p !== 'object' || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out[id] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    n++;
  }
  return out;
}

export type MapStatus = 'scanning' | 'ready' | 'empty' | 'error';

/** Extension host → webview. */
export type HostMessage =
  /** Applies the saved view with this name (undefined shows all tables). */
  | { type: 'applyView'; name?: string }
  /** A (new) schema model. `layout` holds saved manual positions; `focus` selects and centres an entity. */
  | { type: 'model'; model: SchemaModel; layout: Layout; notes?: Notes; views?: SavedView[]; focus?: string }
  /** The user notes changed on disk (`.dbnext/notes.json`). */
  | { type: 'notes'; notes: Notes }
  /** The saved views changed (.dbnext/views.json). */
  | { type: 'views'; views: SavedView[] }
  /** Asks the webview to export the diagram as PNG (e.g. from the command palette). */
  | { type: 'exportPng' }
  /** Scan progress / state. `message` is shown to the user when present. */
  | { type: 'status'; status: MapStatus; message?: string }
  /** Select and centre an entity (e.g. "Show in DB Map" from the tree view). */
  | { type: 'focus'; entityId: string }
  /** Shows the schema diff view; base / head are display labels (branch name, "Working tree"). */
  | { type: 'diff'; diff: SchemaDiff; base: string; head: string };

/** Webview → extension host. */
export type WebviewMessage =
  /** The webview is initialised and listening; the host answers with `status` and `model`. */
  | { type: 'ready' }
  | { type: 'openSource'; ref: SourceRef }
  | { type: 'rescan' }
  | { type: 'exportMarkdown' }
  /** Copies a Mermaid ER diagram; restricted to `entityIds` when given (e.g. the visible subset). */
  | { type: 'copyMermaid'; entityIds?: string[] }
  | { type: 'saveLayout'; layout: Layout }
  /** Replaces the user notes; the host validates and writes `.dbnext/notes.json`. */
  | { type: 'saveNotes'; notes: Notes }
  /** Asks the host to save a standalone SVG document of the current diagram. */
  | { type: 'exportSvg'; svg: string }
  /** Replaces the saved views; the host validates and writes .dbnext/views.json. */
  | { type: 'saveViews'; views: SavedView[] }
  /** Copies DBML or PlantUML text; restricted to entityIds when given. */
  | { type: 'copyText'; format: 'dbml' | 'plantuml'; entityIds?: string[] }
  /** Base64 PNG data rasterised from the SVG export. */
  | { type: 'savePng'; data: string }
  | { type: 'copyDiffMarkdown' }
  | { type: 'showLog' };
