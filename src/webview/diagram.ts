/**
 * The interactive SVG canvas: renders cards + edges, handles pan / zoom / drag / selection, drives
 * the minimap and builds the standalone SVG export. Pan and zoom only touch the world transform —
 * never re-layout — so it stays responsive on large schemas.
 */

import { clear, svg } from './dom';
import { boundsOf, rectCenter, type Rect } from './geometry';
import { createCard, type CardHandles } from './cards';
import { createEdge, type EdgeView, type Pos } from './edges';
import type { CardMetrics } from './cardLayout';
import type { VisibleGraph } from './graphModel';
import type { Viewport } from './types';
import { Minimap } from './minimap';
import { collectStyleSheetText, cssVar, resolveCssVariables } from './theme';

export interface DiagramCallbacks {
  onSelect(id: string | null): void;
  onOpenSource(entityId: string): void;
  onViewportChange(vp: Viewport): void;
  onManualMove(positions: Record<string, Pos>): void;
}

export interface GraphRenderOptions {
  accentClassOf(id: string): string | undefined;
  nameOf(id: string): string;
}

const MIN_SCALE = 0.08;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 4;

interface NodeEntry {
  group: SVGGElement;
  handles: CardHandles;
  metrics: CardMetrics;
}

export class Diagram {
  readonly svgRoot: SVGSVGElement;
  private readonly world: SVGGElement;
  private readonly edgesLayer: SVGGElement;
  private readonly nodesLayer: SVGGElement;
  private readonly minimap: Minimap;

  private vp: Viewport = { x: 0, y: 0, scale: 1 };
  private graph: VisibleGraph | null = null;
  private readonly nodes = new Map<string, NodeEntry>();
  private readonly positions = new Map<string, Pos>();
  private readonly manual = new Set<string>();
  private edgeViews: EdgeView[] = [];
  private readonly edgesByNode = new Map<string, EdgeView[]>();
  private selection: string | null = null;
  private searchMatches = new Set<string>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // interaction state
  private panning: { px: number; py: number; vx: number; vy: number } | null = null;
  private dragging: { id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null = null;
  private spaceDown = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: DiagramCallbacks,
  ) {
    this.svgRoot = svg('svg', { class: 'diagram', 'aria-label': 'Database diagram' });
    this.world = svg('g', { class: 'world' });
    this.edgesLayer = svg('g', { class: 'edges' });
    this.nodesLayer = svg('g', { class: 'nodes' });
    this.world.append(this.edgesLayer, this.nodesLayer);
    this.svgRoot.appendChild(this.world);
    this.container.appendChild(this.svgRoot);

    this.minimap = new Minimap((wx, wy) => this.centerOnWorld(wx, wy, false));
    this.container.appendChild(this.minimap.el);

    this.bindEvents();
  }

  // ── Rendering ────────────────────────────────────────────────────────────────────────────────

  setGraph(graph: VisibleGraph, metrics: Map<string, CardMetrics>, positions: Map<string, Pos>, opts: GraphRenderOptions): void {
    this.graph = graph;
    clear(this.nodesLayer);
    clear(this.edgesLayer);
    this.nodes.clear();
    this.positions.clear();
    this.manual.clear();
    this.edgeViews = [];
    this.edgesByNode.clear();

    for (const e of graph.entities) {
      const m = metrics.get(e.id);
      if (!m) continue;
      const pos = positions.get(e.id) ?? { x: 0, y: 0 };
      this.positions.set(e.id, pos);
      const handles = createCard(m, opts.accentClassOf(e.id));
      handles.group.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      this.nodesLayer.appendChild(handles.group);
      this.nodes.set(e.id, { group: handles.group, handles, metrics: m });
    }

    for (const edge of graph.edges) {
      const fm = metrics.get(edge.from);
      const tm = metrics.get(edge.to);
      if (!fm || !tm) continue;
      const view = createEdge(edge, fm, tm, opts.nameOf);
      view.update(this.positions.get(edge.from)!, this.positions.get(edge.to)!);
      this.edgesLayer.appendChild(view.group);
      this.edgeViews.push(view);
      this.indexEdge(edge.from, view);
      if (edge.to !== edge.from) this.indexEdge(edge.to, view);
    }

    this.applySelectionClasses();
    this.updateMinimap();
  }

  private indexEdge(id: string, view: EdgeView): void {
    let list = this.edgesByNode.get(id);
    if (!list) this.edgesByNode.set(id, (list = []));
    list.push(view);
  }

  // ── Viewport ─────────────────────────────────────────────────────────────────────────────────

  getViewport(): Viewport {
    return { ...this.vp };
  }

  setViewport(vp: Viewport): void {
    this.vp = { x: vp.x, y: vp.y, scale: clampScale(vp.scale) };
    this.applyTransform(false);
  }

  private applyTransform(notify = true): void {
    this.world.setAttribute('transform', `translate(${this.vp.x} ${this.vp.y}) scale(${this.vp.scale})`);
    this.updateMinimapViewport();
    if (notify) this.cb.onViewportChange(this.getViewport());
  }

  private size(): { w: number; h: number } {
    return { w: this.container.clientWidth || 800, h: this.container.clientHeight || 600 };
  }

  contentBounds(): Rect | null {
    const rects: Rect[] = [];
    for (const [id, entry] of this.nodes) {
      const p = this.positions.get(id)!;
      rects.push({ x: p.x, y: p.y, width: entry.metrics.width, height: entry.metrics.height });
    }
    return boundsOf(rects);
  }

  fit(animate = false): void {
    const bounds = this.contentBounds();
    const { w, h } = this.size();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.setViewportAnimated({ x: w / 2, y: h / 2, scale: 1 }, false);
      return;
    }
    const pad = 48;
    const scale = clampScale(Math.min((w - pad * 2) / bounds.width, (h - pad * 2) / bounds.height, MAX_SCALE));
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    this.setViewportAnimated({ x: w / 2 - cx * scale, y: h / 2 - cy * scale, scale }, animate);
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const { w, h } = this.size();
    const ax = cx ?? w / 2;
    const ay = cy ?? h / 2;
    const newScale = clampScale(this.vp.scale * factor);
    const wx = (ax - this.vp.x) / this.vp.scale;
    const wy = (ay - this.vp.y) / this.vp.scale;
    this.vp = { scale: newScale, x: ax - wx * newScale, y: ay - wy * newScale };
    this.applyTransform();
  }

  resetZoom(): void {
    this.zoomBy(1 / this.vp.scale);
  }

  private centerOnWorld(wx: number, wy: number, animate: boolean): void {
    const { w, h } = this.size();
    this.setViewportAnimated({ x: w / 2 - wx * this.vp.scale, y: h / 2 - wy * this.vp.scale, scale: this.vp.scale }, animate);
  }

  /**
   * Centres an entity. With `minScale`, also zooms in when the current zoom would render it too
   * small to read (e.g. "Show in DB Map" on a large, zoomed-out schema).
   */
  centerEntity(id: string, animate = true, minScale?: number): void {
    const entry = this.nodes.get(id);
    const p = this.positions.get(id);
    if (!entry || !p) return;
    const wx = p.x + entry.metrics.width / 2;
    const wy = p.y + entry.metrics.height / 2;
    if (minScale !== undefined && this.vp.scale < minScale) {
      const { w, h } = this.size();
      const scale = clampScale(minScale);
      this.setViewportAnimated({ x: w / 2 - wx * scale, y: h / 2 - wy * scale, scale }, animate);
      return;
    }
    this.centerOnWorld(wx, wy, animate);
  }

  private setViewportAnimated(target: Viewport, animate: boolean): void {
    if (!animate || this.reducedMotion) {
      this.vp = { ...target, scale: clampScale(target.scale) };
      this.applyTransform();
      return;
    }
    const start = { ...this.vp };
    const dur = 240;
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.vp = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        scale: start.scale + (target.scale - start.scale) * e,
      };
      this.applyTransform();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── Selection & highlighting ──────────────────────────────────────────────────────────────────

  getSelection(): string | null {
    return this.selection;
  }

  select(id: string | null, notify = true): void {
    this.selection = id && this.nodes.has(id) ? id : null;
    this.applySelectionClasses();
    this.updateMinimap();
    if (notify) this.cb.onSelect(this.selection);
  }

  focusSelection(): void {
    if (this.selection) this.centerEntity(this.selection, true);
  }

  private applySelectionClasses(): void {
    const sel = this.selection;
    this.svgRoot.classList.toggle('has-selection', !!sel);
    const neighbors = sel ? this.graph?.neighbors.get(sel) ?? new Set<string>() : new Set<string>();
    for (const [id, entry] of this.nodes) {
      entry.group.classList.toggle('selected', id === sel);
      entry.group.classList.toggle('neighbor', !!sel && neighbors.has(id));
      entry.group.classList.toggle('dimmed', !!sel && id !== sel && !neighbors.has(id));
    }
    for (const view of this.edgeViews) {
      const active = !!sel && (view.fromId === sel || view.toId === sel);
      view.group.classList.toggle('active', active);
      view.group.classList.toggle('dim', !!sel && !active);
    }
  }

  setSearchMatches(ids: readonly string[], current?: string): void {
    const next = new Set(ids);
    for (const id of this.searchMatches) {
      if (!next.has(id)) this.nodes.get(id)?.group.classList.remove('search-match', 'search-current');
    }
    for (const id of next) {
      const g = this.nodes.get(id)?.group;
      if (g) {
        g.classList.add('search-match');
        g.classList.toggle('search-current', id === current);
      }
    }
    // make sure only `current` carries the current class
    if (current) {
      for (const id of next) {
        if (id !== current) this.nodes.get(id)?.group.classList.remove('search-current');
      }
    }
    this.searchMatches = next;
  }

  // ── Interaction ───────────────────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    const sr = this.svgRoot;
    sr.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    sr.addEventListener('pointermove', (e) => this.onPointerMove(e));
    sr.addEventListener('pointerup', (e) => this.onPointerUp(e));
    sr.addEventListener('dblclick', (e) => this.onDblClick(e));
    sr.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    sr.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isFormField(e.target)) this.spaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  /** Keyboard on a focused node: Enter/Space selects, arrow keys move to a connected entity. */
  private onKeyDown(e: KeyboardEvent): void {
    const id = this.nodeIdFrom(document.activeElement);
    if (!id) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.select(id);
      this.centerEntity(id, true);
      return;
    }
    if (!e.key.startsWith('Arrow')) return;
    const here = this.centerPointOf(id);
    const neighbors = this.graph?.neighbors.get(id);
    if (!here || !neighbors) return;
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const n of neighbors) {
      const c = this.centerPointOf(n);
      if (!c) continue;
      const dx = c.x - here.x;
      const dy = c.y - here.y;
      const score =
        e.key === 'ArrowRight' ? dx - Math.abs(dy) :
        e.key === 'ArrowLeft' ? -dx - Math.abs(dy) :
        e.key === 'ArrowUp' ? -dy - Math.abs(dx) :
        dy - Math.abs(dx);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best) {
      e.preventDefault();
      this.nodes.get(best)?.group.focus();
      this.select(best);
      this.centerEntity(best, true);
    }
  }

  private screenPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private nodeIdFrom(target: EventTarget | null): string | null {
    const el = (target as Element | null)?.closest?.('.node') as SVGGElement | null;
    return el?.getAttribute('data-id') ?? null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const nodeId = this.nodeIdFrom(e.target);
    const pan = e.button === 1 || this.spaceDown || !nodeId;
    this.svgRoot.setPointerCapture(e.pointerId);
    if (pan) {
      this.panning = { px: e.clientX, py: e.clientY, vx: this.vp.x, vy: this.vp.y };
      this.svgRoot.classList.add('panning');
    } else if (nodeId) {
      const p = this.positions.get(nodeId)!;
      this.dragging = { id: nodeId, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false };
    }
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.panning) {
      this.vp = { ...this.vp, x: this.panning.vx + (e.clientX - this.panning.px), y: this.panning.vy + (e.clientY - this.panning.py) };
      this.applyTransform();
    } else if (this.dragging) {
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      if (!this.dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.dragging.moved = true;
      const id = this.dragging.id;
      const pos = { x: this.dragging.origX + dx / this.vp.scale, y: this.dragging.origY + dy / this.vp.scale };
      this.positions.set(id, pos);
      this.manual.add(id);
      this.nodes.get(id)!.group.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      for (const view of this.edgesByNode.get(id) ?? []) {
        view.update(this.positions.get(view.fromId)!, this.positions.get(view.toId)!);
      }
      this.updateMinimap();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    try {
      this.svgRoot.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.panning) {
      this.panning = null;
      this.svgRoot.classList.remove('panning');
      return;
    }
    if (this.dragging) {
      const { id, moved } = this.dragging;
      this.dragging = null;
      if (moved) this.cb.onManualMove(this.manualPositions());
      else this.select(id);
      return;
    }
    // background click clears selection
    if (!this.nodeIdFrom(e.target)) this.select(null);
  }

  private onDblClick(e: MouseEvent): void {
    const id = this.nodeIdFrom(e.target);
    if (id) {
      this.select(id);
      this.cb.onOpenSource(id);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.screenPoint(e);
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoomBy(factor, p.x, p.y);
    } else {
      this.vp = { ...this.vp, x: this.vp.x - e.deltaX, y: this.vp.y - e.deltaY };
      this.applyTransform();
    }
  }

  manualPositions(): Record<string, Pos> {
    const out: Record<string, Pos> = {};
    for (const id of this.manual) {
      const p = this.positions.get(id);
      if (p) out[id] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    }
    return out;
  }

  allPositions(): Record<string, Pos> {
    const out: Record<string, Pos> = {};
    for (const [id, p] of this.positions) out[id] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    return out;
  }

  visibleEntityIds(): string[] {
    return this.graph ? this.graph.entities.map((e) => e.id) : [];
  }

  // ── Minimap ───────────────────────────────────────────────────────────────────────────────────

  setMinimapVisible(v: boolean): void {
    this.minimap.setVisible(v);
  }

  /** Re-syncs the minimap viewport box after a container resize. */
  resize(): void {
    this.updateMinimapViewport();
  }

  private updateMinimap(): void {
    const rects = [...this.nodes.entries()].map(([id, entry]) => {
      const p = this.positions.get(id)!;
      return { x: p.x, y: p.y, width: entry.metrics.width, height: entry.metrics.height, selected: id === this.selection };
    });
    this.minimap.setNodes(rects, this.contentBounds());
    this.updateMinimapViewport();
  }

  private updateMinimapViewport(): void {
    const { w, h } = this.size();
    const view: Rect = {
      x: -this.vp.x / this.vp.scale,
      y: -this.vp.y / this.vp.scale,
      width: w / this.vp.scale,
      height: h / this.vp.scale,
    };
    this.minimap.setViewport(view);
  }

  // ── SVG export ────────────────────────────────────────────────────────────────────────────────

  buildExportSvg(): string {
    const bounds = this.contentBounds();
    const pad = 32;
    const b = bounds ?? { x: 0, y: 0, width: 100, height: 100 };
    const x = b.x - pad;
    const y = b.y - pad;
    const width = b.width + pad * 2;
    const height = b.height + pad * 2;

    const out = svg('svg', {
      xmlns: 'http://www.w3.org/2000/svg',
      width: String(Math.round(width)),
      height: String(Math.round(height)),
      viewBox: `${round(x)} ${round(y)} ${round(width)} ${round(height)}`,
    });

    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = resolveCssVariables(collectStyleSheetText());
    out.appendChild(styleEl);

    const background = cssVar('--vscode-editor-background') || '#ffffff';
    out.appendChild(svg('rect', { x: round(x), y: round(y), width: round(width), height: round(height), fill: background }));

    const edgesClone = this.edgesLayer.cloneNode(true) as SVGGElement;
    const nodesClone = this.nodesLayer.cloneNode(true) as SVGGElement;
    for (const el of Array.from(edgesClone.querySelectorAll('.edge'))) el.classList.remove('active', 'dim');
    for (const el of Array.from(nodesClone.querySelectorAll('.node'))) el.classList.remove('selected', 'neighbor', 'dimmed', 'search-match', 'search-current');
    out.append(edgesClone, nodesClone);

    const xml = new XMLSerializer().serializeToString(out);
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${xml}`;
  }

  centerPointOf(id: string): Pos | null {
    const entry = this.nodes.get(id);
    const p = this.positions.get(id);
    if (!entry || !p) return null;
    const c = rectCenter({ x: p.x, y: p.y, width: entry.metrics.width, height: entry.metrics.height });
    return c;
  }
}

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function isFormField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
