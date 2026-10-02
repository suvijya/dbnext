/**
 * Shared UI types for the DB Map webview.
 * DOM-free so it can be imported by pure logic modules and their tests.
 */

export type ColumnMode = 'all' | 'keys' | 'none';
export type Direction = 'LR' | 'TB';

export interface Viewport {
  /** Translation applied to the world group, in CSS pixels. */
  x: number;
  y: number;
  /** Zoom factor (1 = 100%). */
  scale: number;
}

/** Number of hops kept around the selection in focus mode (0 = focus mode off). */
export type FocusHops = 0 | 1 | 2;

/**
 * Filter settings. For schemas / sources / engines we remember which values the user *disabled*
 * (unchecked), so values that appear in a newly scanned model default to visible.
 */
export interface Filters {
  disabledSchemas: string[];
  disabledSources: string[];
  disabledEngines: string[];
  hideExternal: boolean;
  hideInferred: boolean;
  /** Hide pure junction tables and draw many-to-many relations as a direct edge instead. */
  hideJoinTables: boolean;
  focusHops: FocusHops;
}

export function defaultFilters(): Filters {
  return {
    disabledSchemas: [],
    disabledSources: [],
    disabledEngines: [],
    hideExternal: false,
    hideInferred: false,
    hideJoinTables: false,
    focusHops: 0,
  };
}

/** Persisted UI state (survives reloads via vscode.setState / getState). */
export interface UiState {
  viewport: Viewport | null;
  columnMode: ColumnMode;
  /** The user picked `columnMode` (otherwise it is chosen automatically from the schema size). */
  columnModeChosen: boolean;
  direction: Direction;
  selection: string | null;
  filters: Filters;
  /** Entity ids whose long column lists the user expanded. */
  expanded: string[];
  /** Computed layout positions, kept so a reload does not reshuffle the diagram. */
  positions: Record<string, { x: number; y: number }>;
  sidePanelOpen: boolean;
}

export function defaultUiState(): UiState {
  return {
    viewport: null,
    columnMode: 'all',
    columnModeChosen: false,
    direction: 'LR',
    selection: null,
    filters: defaultFilters(),
    expanded: [],
    positions: {},
    sidePanelOpen: true,
  };
}

const COLUMN_MODES: ReadonlySet<string> = new Set(['all', 'keys', 'none']);
const DIRECTIONS: ReadonlySet<string> = new Set(['LR', 'TB']);

/**
 * Column detail for a schema the user has not configured: all columns for small schemas, key
 * columns only from 40 tables (cards stay small enough to show the structure), header only beyond
 * 250 tables. The user's own choice always wins.
 */
export function autoColumnMode(entityCount: number): ColumnMode {
  if (entityCount >= 250) return 'none';
  if (entityCount >= 40) return 'keys';
  return 'all';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** Validates / repairs state read back from the host (it is persisted untrusted JSON). */
export function sanitizeUiState(value: unknown): UiState {
  const s = defaultUiState();
  if (!value || typeof value !== 'object') return s;
  const v = value as Record<string, unknown>;

  if (COLUMN_MODES.has(v.columnMode as string)) s.columnMode = v.columnMode as ColumnMode;
  if (typeof v.columnModeChosen === 'boolean') s.columnModeChosen = v.columnModeChosen;
  if (DIRECTIONS.has(v.direction as string)) s.direction = v.direction as Direction;
  if (typeof v.selection === 'string') s.selection = v.selection;
  if (typeof v.sidePanelOpen === 'boolean') s.sidePanelOpen = v.sidePanelOpen;
  s.expanded = strArray(v.expanded);

  const vp = v.viewport as Partial<Viewport> | null | undefined;
  if (vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.scale === 'number' &&
    Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.scale) && vp.scale > 0) {
    s.viewport = { x: vp.x, y: vp.y, scale: vp.scale };
  }

  const f = v.filters as Record<string, unknown> | undefined;
  if (f && typeof f === 'object') {
    s.filters.disabledSchemas = strArray(f.disabledSchemas);
    s.filters.disabledSources = strArray(f.disabledSources);
    s.filters.disabledEngines = strArray(f.disabledEngines);
    s.filters.hideExternal = f.hideExternal === true;
    s.filters.hideInferred = f.hideInferred === true;
    s.filters.hideJoinTables = f.hideJoinTables === true;
    if (f.focusHops === 1 || f.focusHops === 2) s.filters.focusHops = f.focusHops;
  }

  const pos = v.positions;
  if (pos && typeof pos === 'object' && !Array.isArray(pos)) {
    for (const [id, p] of Object.entries(pos as Record<string, unknown>)) {
      const q = p as { x?: unknown; y?: unknown } | null;
      if (q && typeof q.x === 'number' && typeof q.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y)) {
        s.positions[id] = { x: q.x, y: q.y };
      }
    }
  }
  return s;
}
