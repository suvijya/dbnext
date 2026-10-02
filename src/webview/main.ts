/**
 * DB Map webview entry point.
 *
 * Wires the toolbar, diagram, side panel and state overlays together, keeps the UI state in
 * vscode.setState so it survives reloads, and speaks the HostMessage / WebviewMessage protocol.
 * Model updates preserve the viewport, the selection and the positions of unchanged nodes.
 */

import './main.css';

import type { HostMessage, Layout } from '../core/protocol';
import type { SchemaModel } from '../core/model';
import { qualifiedName } from '../core/format';

import { post, vscode } from './vscode';
import { autoColumnMode, sanitizeUiState, type ColumnMode, type Direction, type Filters, type UiState } from './types';
import { computeVisibleGraph, schemaKey, type VisibleGraph } from './graphModel';
import { computeLayout, type SizedNode } from './layout';
import { computeCardMetrics, type CardMetrics } from './cardLayout';
import { Measurer, readFonts } from './measure';
import { boundsOf, type Rect } from './geometry';
import { Diagram } from './diagram';
import { Toolbar, type FilterOption } from './toolbar';
import { SidePanel } from './sidePanel';
import { Overlays } from './overlays';
import { buildSearchItems, matchedEntityIds, search, type SearchItem } from './search';

interface Pos {
  x: number;
  y: number;
}

const LAYOUT_GAP = 56;
const PROGRESS_THRESHOLD = 150; // tables beyond this show a progress chip and defer layout
/** Zoom level at which card text is comfortably readable; focusing / search zoom in to at least this. */
const READABLE_SCALE = 0.8;

class App {
  private readonly state: UiState;
  private model: SchemaModel | null = null;
  private entitiesById = new Map<string, SchemaModel['entities'][number]>();
  private accentBySchema = new Map<string, string>();
  private measurer: Measurer | null = null;
  /** Manual positions (from the host's saved layout + this session's drags). */
  private manual: Layout = {};
  private firstModel = true;
  private pendingFocus: string | null = null;

  private searchItems: SearchItem[] = [];
  private searchQuery = '';
  private searchIds: string[] = [];
  private searchIndex = -1;

  private visible: VisibleGraph | null = null;

  private persistTimer = 0;
  private saveLayoutTimer = 0;

  private readonly diagram: Diagram;
  private readonly toolbar: Toolbar;
  private readonly sidePanel: SidePanel;
  private readonly overlays: Overlays;

  constructor(root: HTMLElement) {
    this.state = sanitizeUiState(vscode.getState());

    this.overlays = new Overlays({
      onRescan: () => post({ type: 'rescan' }),
      onShowLog: () => post({ type: 'showLog' }),
    });

    this.toolbar = new Toolbar(
      { columnMode: this.state.columnMode, direction: this.state.direction, filters: this.state.filters },
      {
        onSearch: (q) => this.onSearch(q),
        onSearchCycle: (d) => this.cycleSearch(d),
        onFit: () => this.diagram.fit(true),
        onZoom: (k) => (k === 'in' ? this.diagram.zoomBy(1.2) : k === 'out' ? this.diagram.zoomBy(1 / 1.2) : this.diagram.resetZoom()),
        onDirection: (dir) => this.setDirection(dir),
        onColumnMode: (mode) => this.setColumnMode(mode),
        onFiltersChange: (f) => this.setFilters(f),
        onRelayout: () => this.relayout(),
        onExport: (kind) => this.onExport(kind),
        onRescan: () => post({ type: 'rescan' }),
        onTogglePanel: () => this.togglePanel(),
      },
    );

    this.sidePanel = new SidePanel({
      onJump: (id) => this.selectEntity(id, true),
      onOpenRef: (ref) => post({ type: 'openSource', ref }),
      onShowLog: () => post({ type: 'showLog' }),
      onClose: () => this.togglePanel(false),
    });

    const stage = document.createElement('div');
    stage.className = 'stage';
    const diagramHost = document.createElement('div');
    diagramHost.className = 'diagram-host';
    stage.append(diagramHost, this.overlays.el, this.overlays.busyChip);

    const main = document.createElement('div');
    main.className = 'main';
    main.append(stage, this.sidePanel.el);

    root.append(this.toolbar.el, main, this.overlays.liveRegion);

    this.diagram = new Diagram(diagramHost, {
      onSelect: (id) => this.onDiagramSelect(id),
      onOpenSource: (id) => this.openEntitySource(id),
      onViewportChange: (vp) => {
        this.state.viewport = vp;
        this.toolbar.setZoom(vp.scale);
        this.schedulePersist();
      },
      onManualMove: (positions) => this.onManualMove(positions),
    });

    this.applyPanelVisibility();
    this.bindGlobalKeys();
    window.addEventListener('resize', () => this.diagram.resize());
  }

  // ── Messaging ──────────────────────────────────────────────────────────────────────────────────

  handleMessage(m: HostMessage): void {
    if (m.type === 'status') {
      this.overlays.update(m.status, m.message, !!this.model);
    } else if (m.type === 'model') {
      this.onModel(m.model, m.layout, m.focus);
    } else if (m.type === 'focus') {
      this.focusEntity(m.entityId);
    }
  }

  private onModel(model: SchemaModel, layout: Layout, focus: string | undefined): void {
    this.model = model;
    this.applyPanelVisibility();
    this.entitiesById = new Map(model.entities.map((e) => [e.id, e]));
    this.manual = { ...layout };
    this.measurer = new Measurer(readFonts(document.body));
    this.searchItems = buildSearchItems(model.entities);

    // Accent colour per non-default schema.
    this.accentBySchema.clear();
    const schemas = [...new Set(model.entities.map((e) => e.schema).filter((s): s is string => !!s))].sort();
    schemas.forEach((s, i) => this.accentBySchema.set(s, `accent-${i % 8}`));

    // Drop persisted positions for entities that no longer exist.
    const ids = new Set(model.entities.map((e) => e.id));
    for (const id of Object.keys(this.state.positions)) if (!ids.has(id)) delete this.state.positions[id];

    // Keep selection only if still present.
    if (this.state.selection && !ids.has(this.state.selection)) this.state.selection = null;

    this.sidePanel.setModel(model);
    this.updateFilterOptions();
    this.pendingFocus = focus ?? this.pendingFocus;

    // Large schemas start with compact cards (key columns / header only) so the structure is
    // readable when zoomed to fit; the toolbar switches back to all columns at any time.
    if (!this.state.columnModeChosen) {
      const mode = autoColumnMode(model.entities.filter((e) => !e.external).length);
      if (mode !== this.state.columnMode) {
        this.state.columnMode = mode;
        this.toolbar.setColumnMode(mode);
      }
    }

    this.rebuild({ reason: 'model' });
    this.overlays.update('ready', undefined, true);
  }

  // ── Rebuild pipeline ─────────────────────────────────────────────────────────────────────────

  private rebuild(opts: { reason: 'model' | 'filters' | 'layout' | 'relayout'; fit?: boolean }): void {
    if (!this.model || !this.measurer) return;
    const graph = computeVisibleGraph(this.model, this.state.filters, this.state.selection);
    this.visible = graph;

    const metrics = new Map<string, CardMetrics>();
    for (const e of graph.entities) {
      metrics.set(e.id, computeCardMetrics(e, this.state.columnMode, this.state.expanded.includes(e.id), this.measurer));
    }

    const existing = this.existingPositions(opts.reason);
    const missing = graph.entities.filter((e) => !existing.has(e.id));
    const heavy = graph.entities.length > PROGRESS_THRESHOLD && missing.length > 0;

    const finish = (): void => {
      const positions = this.placePositions(graph, metrics, existing);
      this.diagram.setGraph(graph, metrics, positions, {
        accentClassOf: (id) => this.accentOf(id),
        nameOf: (id) => this.nameOf(id),
      });
      this.afterRender(opts);
      this.overlays.setBusy(null);
    };

    if (heavy) {
      this.overlays.setBusy(`Laying out ${graph.entities.length} tables…`);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      finish();
    }
  }

  private afterRender(opts: { reason: string; fit?: boolean }): void {
    // Viewport: fit on first model load (unless a saved viewport exists) and on explicit relayout/fit.
    if (opts.fit || opts.reason === 'relayout') {
      this.diagram.fit(opts.reason !== 'model');
    } else if (this.firstModel && this.state.viewport) {
      this.diagram.setViewport(this.state.viewport);
    } else if (this.firstModel) {
      this.diagram.fit(false);
    }
    this.firstModel = false;

    // Persist the computed layout so a reload keeps the same arrangement.
    this.state.positions = this.diagram.allPositions();
    this.toolbar.setZoom(this.diagram.getViewport().scale);

    // Restore / re-apply selection.
    if (this.state.selection) this.diagram.select(this.state.selection, false);
    this.sidePanel.render(this.state.selection);

    // Pending focus (from host) takes priority once rendered.
    if (this.pendingFocus) {
      const target = this.pendingFocus;
      this.pendingFocus = null;
      this.focusEntity(target);
    }

    this.reapplySearch();
    this.schedulePersist();
  }

  /** Positions already known for the current nodes (session-persisted + manual overrides). */
  private existingPositions(reason: string): Map<string, Pos> {
    const base = new Map<string, Pos>();
    const useSession = reason === 'model' || reason === 'filters';
    if (useSession) {
      for (const [id, p] of Object.entries(this.state.positions)) base.set(id, p);
    }
    // Manual drags / host-saved layout always win.
    for (const [id, p] of Object.entries(this.manual)) base.set(id, p);
    return base;
  }

  /** Keeps known node positions; lays out only the nodes that do not have one yet. */
  private placePositions(graph: VisibleGraph, metrics: Map<string, CardMetrics>, existing: Map<string, Pos>): Map<string, Pos> {
    const known = new Map<string, Pos>();
    for (const e of graph.entities) {
      const p = existing.get(e.id);
      if (p) known.set(e.id, p);
    }
    const missing = graph.entities.filter((e) => !known.has(e.id));
    if (missing.length === 0) return known;

    const edgePairs = graph.edges.filter((e) => !e.self).map((e) => [e.from, e.to] as [string, string]);

    const t0 = performance.now();
    if (known.size === 0) {
      const nodes: SizedNode[] = graph.entities.map((e) => sized(e.id, metrics));
      const res = computeLayout({ nodes, edges: edgePairs, direction: this.state.direction });
      this.logLayout(nodes.length, performance.now() - t0);
      return res.positions;
    }

    // Lay out just the new nodes among themselves, then drop the block to the right of the rest.
    const missingSet = new Set(missing.map((e) => e.id));
    const subNodes: SizedNode[] = missing.map((e) => sized(e.id, metrics));
    const subEdges = edgePairs.filter(([a, b]) => missingSet.has(a) && missingSet.has(b));
    const res = computeLayout({ nodes: subNodes, edges: subEdges, direction: this.state.direction });
    this.logLayout(subNodes.length, performance.now() - t0);

    const knownRects: Rect[] = [...known].map(([id, p]) => ({ x: p.x, y: p.y, width: metrics.get(id)!.width, height: metrics.get(id)!.height }));
    const kb = boundsOf(knownRects);
    const offX = kb ? kb.x + kb.width + LAYOUT_GAP : 0;
    const offY = kb ? kb.y : 0;
    const out = new Map(known);
    for (const [id, p] of res.positions) out.set(id, { x: p.x + offX, y: p.y + offY });
    return out;
  }

  private logLayout(count: number, ms: number): void {
    // Visible in the preview console; useful for the performance report.
    // eslint-disable-next-line no-console
    console.log(`[dbnext] laid out ${count} nodes in ${ms.toFixed(1)}ms`);
  }

  // ── Selection / focus ────────────────────────────────────────────────────────────────────────

  private onDiagramSelect(id: string | null): void {
    this.state.selection = id;
    this.sidePanel.render(id);
    this.schedulePersist();
    if (this.state.filters.focusHops > 0) this.rebuild({ reason: 'filters' });
  }

  private selectEntity(id: string, center: boolean): void {
    this.diagram.select(id); // triggers onDiagramSelect
    if (center) this.diagram.centerEntity(id, true);
  }

  private focusEntity(id: string): void {
    if (!this.visible?.ids.has(id)) {
      // The entity is filtered out — reveal it by clearing focus mode so it can be shown.
      if (this.state.filters.focusHops > 0) {
        this.state.filters.focusHops = 0;
        this.toolbar.setFilters(this.state.filters);
      }
    }
    this.state.selection = id;
    this.rebuild({ reason: 'filters' });
    this.diagram.select(id, false);
    this.sidePanel.render(id);
    this.diagram.centerEntity(id, true, READABLE_SCALE);
  }

  private openEntitySource(id: string): void {
    const e = this.entitiesById.get(id);
    if (e?.source) post({ type: 'openSource', ref: e.source });
  }

  // ── Search ───────────────────────────────────────────────────────────────────────────────────

  private onSearch(query: string): void {
    this.searchQuery = query;
    this.reapplySearch();
  }

  private reapplySearch(): void {
    if (!this.searchQuery.trim() || !this.visible) {
      this.searchIds = [];
      this.searchIndex = -1;
      this.diagram.setSearchMatches([]);
      this.toolbar.setSearchStatus(0, 0);
      return;
    }
    const hits = search(this.searchItems, this.searchQuery);
    const visibleIds = this.visible.ids;
    this.searchIds = matchedEntityIds(hits).filter((id) => visibleIds.has(id));
    this.searchIndex = this.searchIds.length ? 0 : -1;
    const current = this.searchIndex >= 0 ? this.searchIds[this.searchIndex] : undefined;
    this.diagram.setSearchMatches(this.searchIds, current);
    this.toolbar.setSearchStatus(this.searchIndex + 1, this.searchIds.length);
  }

  private cycleSearch(dir: 1 | -1): void {
    if (!this.searchIds.length) return;
    this.searchIndex = (this.searchIndex + dir + this.searchIds.length) % this.searchIds.length;
    const id = this.searchIds[this.searchIndex];
    this.diagram.setSearchMatches(this.searchIds, id);
    this.toolbar.setSearchStatus(this.searchIndex + 1, this.searchIds.length);
    this.diagram.centerEntity(id, true, READABLE_SCALE);
    this.selectEntity(id, false);
  }

  // ── Toolbar state ────────────────────────────────────────────────────────────────────────────

  private setDirection(dir: Direction): void {
    this.state.direction = dir;
    this.toolbar.setDirection(dir);
    this.rebuild({ reason: 'layout', fit: true });
    this.schedulePersist();
  }

  private setColumnMode(mode: ColumnMode): void {
    this.state.columnMode = mode;
    this.state.columnModeChosen = true;
    this.toolbar.setColumnMode(mode);
    this.rebuild({ reason: 'layout' });
    this.schedulePersist();
  }

  private setFilters(filters: Filters): void {
    this.state.filters = filters;
    this.rebuild({ reason: 'filters' });
    this.schedulePersist();
  }

  private relayout(): void {
    this.manual = {};
    this.state.positions = {};
    this.clearSaveLayout();
    post({ type: 'saveLayout', layout: {} });
    this.rebuild({ reason: 'relayout' });
  }

  private onExport(kind: 'markdown' | 'mermaid' | 'svg'): void {
    if (kind === 'markdown') post({ type: 'exportMarkdown' });
    else if (kind === 'mermaid') post({ type: 'copyMermaid', ...this.visibleSubset() });
    else post({ type: 'exportSvg', svg: this.diagram.buildExportSvg() });
  }

  /** `copyMermaid` wants entityIds only when a subset is shown; omit when all are visible. */
  private visibleSubset(): { entityIds?: string[] } {
    if (!this.model || !this.visible) return {};
    const all = this.model.entities.length;
    const ids = this.diagram.visibleEntityIds();
    return ids.length === all ? {} : { entityIds: ids };
  }

  private togglePanel(force?: boolean): void {
    this.state.sidePanelOpen = force ?? !this.state.sidePanelOpen;
    this.applyPanelVisibility();
    this.schedulePersist();
  }

  private applyPanelVisibility(): void {
    // Without a model (empty / error / first scan) there is nothing to show in the panel or minimap.
    this.sidePanel.el.classList.toggle('hidden', !this.state.sidePanelOpen || !this.model);
    this.diagram?.setMinimapVisible(!!this.model);
  }

  // ── Manual move / persistence ──────────────────────────────────────────────────────────────────

  private onManualMove(positions: Record<string, Pos>): void {
    this.manual = { ...this.manual, ...positions };
    for (const [id, p] of Object.entries(positions)) this.state.positions[id] = p;
    this.scheduleSaveLayout();
    this.schedulePersist();
  }

  private scheduleSaveLayout(): void {
    this.clearSaveLayout();
    this.saveLayoutTimer = window.setTimeout(() => {
      post({ type: 'saveLayout', layout: this.manual });
    }, 500);
  }

  private clearSaveLayout(): void {
    if (this.saveLayoutTimer) {
      clearTimeout(this.saveLayoutTimer);
      this.saveLayoutTimer = 0;
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = 0;
      vscode.setState(this.state);
    }, 300);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  private updateFilterOptions(): void {
    if (!this.model) return;
    const schemaSet = new Set<string>();
    const sourceSet = new Set<string>();
    const engineMap = new Map<string, string>();
    for (const e of this.model.entities) {
      schemaSet.add(schemaKey(e));
      for (const s of e.sources) sourceSet.add(s);
      if (e.engine) engineMap.set(e.engine, e.engine);
    }
    const schemas: FilterOption[] = [...schemaSet].sort().map((s) => ({ value: s, label: s }));
    const sources: FilterOption[] = this.model.sources.map((s) => ({ value: s.kind, label: s.label }));
    for (const s of sourceSet) if (!sources.some((o) => o.value === s)) sources.push({ value: s, label: s });
    const engines: FilterOption[] = this.model.engines.map((e) => ({ value: e.id, label: e.label }));
    this.toolbar.setFilterOptions(schemas, sources, engines);
    this.toolbar.setFilters(this.state.filters);
  }

  private accentOf(id: string): string | undefined {
    const e = this.entitiesById.get(id);
    return e?.schema ? this.accentBySchema.get(e.schema) : undefined;
  }

  private nameOf(id: string): string {
    const e = this.entitiesById.get(id);
    if (e) return qualifiedName(e);
    const en = this.model?.enums.find((x) => x.id === id);
    return en ? (en.schema ? `${en.schema}.${en.name}` : en.name) : id;
  }

  private bindGlobalKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      switch (e.key) {
        case '+':
        case '=':
          this.diagram.zoomBy(1.2);
          break;
        case '-':
        case '_':
          this.diagram.zoomBy(1 / 1.2);
          break;
        case '0':
          this.diagram.fit(true);
          break;
        case 'f':
        case 'F':
          this.diagram.focusSelection();
          break;
        case 'Escape':
          if (this.state.selection) this.selectEntityNull();
          break;
        default:
          return;
      }
    });
  }

  private selectEntityNull(): void {
    this.diagram.select(null);
  }
}

function sized(id: string, metrics: Map<string, CardMetrics>): SizedNode {
  const m = metrics.get(id)!;
  return { id, width: m.width, height: m.height };
}

// ── Boot ─────────────────────────────────────────────────────────────────────────────────────

const root = document.getElementById('app') ?? document.body;
root.classList.add('dbnext-root');
const app = new App(root as HTMLElement);
window.addEventListener('message', (event: MessageEvent<HostMessage>) => app.handleMessage(event.data));
post({ type: 'ready' });
