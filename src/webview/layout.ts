/**
 * Diagram layout: runs dagre on each connected component, then packs the components (largest first)
 * and the isolated tables into a tidy grid. Pure (no DOM); node sizes are provided by the caller so
 * this module can be unit tested in a node environment.
 *
 * Real schemas have hub tables (`users`, `accounts`) referenced by dozens of tables. dagre puts all of
 * them into one rank, which turns the diagram into a very tall (LR) or very wide (TB) strip. Ranks that
 * are too long are therefore wrapped into several sub-columns (sub-rows for TB), with the wrap length
 * chosen so that each component ends up close to a landscape aspect ratio.
 */

import dagre from '@dagrejs/dagre';
import type { Direction } from './types';
import { connectedComponents } from './graphModel';

export interface SizedNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutInput {
  nodes: readonly SizedNode[];
  /** Directed edge pairs (from, to); self edges are ignored. */
  edges: readonly [string, string][];
  direction: Direction;
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

const COMPONENT_GAP = 56;
const ISOLATED_GAP = 24;
const NODE_SEP = 28;
const RANK_SEP = 80;
/** Gap between the sub-columns of a wrapped rank. */
const WRAP_SEP = 36;
/** Preferred width / height of a component. */
const TARGET_ASPECT = 1.6;
/** dagre layouts whose cards cover less of their bounding box than this are compacted. */
const MIN_DENSITY = 0.12;

interface Block {
  width: number;
  height: number;
  /** Local node offsets (top-left) relative to the block origin. */
  nodes: { id: string; x: number; y: number }[];
}

/** Node centre as produced by dagre. */
interface Center {
  id: string;
  cx: number;
  cy: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// dagre per component
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs dagre on one component. Parallel and reverse edges are collapsed into one weighted edge per
 * node pair: dagre only ranks/orders nodes here (edges are routed by the renderer), and parallel
 * edges are what triggers dagre's "Not possible to find intersection" error on real schemas.
 * Returns `undefined` when dagre fails.
 */
function dagreCenters(
  nodeIds: readonly string[],
  sizes: Map<string, SizedNode>,
  adjacency: Map<string, [string, string][]>,
  direction: Direction,
): Center[] | undefined {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const idSet = new Set(nodeIds);
  for (const id of nodeIds) {
    const s = sizes.get(id)!;
    g.setNode(id, { width: s.width, height: s.height });
  }
  const pairs = new Map<string, { v: string; w: string; weight: number }>();
  for (const id of nodeIds) {
    for (const [a, b] of adjacency.get(id) ?? []) {
      if (a !== id || a === b || !idSet.has(b)) continue;
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      const p = pairs.get(key);
      if (p) p.weight++;
      else pairs.set(key, { v: a, w: b, weight: 1 });
    }
  }
  for (const p of pairs.values()) g.setEdge(p.v, p.w, { weight: p.weight, minlen: 1 });
  try {
    dagre.layout(g);
  } catch {
    return undefined;
  }
  const out: Center[] = [];
  for (const id of nodeIds) {
    const n = g.node(id) as { x?: number; y?: number } | undefined;
    if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return undefined;
    out.push({ id, cx: n.x!, cy: n.y! });
  }
  return out;
}

/** Breadth-first order from the most connected node, so neighbours stay close in a grid fallback. */
function neighbourOrder(nodeIds: readonly string[], adjacency: Map<string, [string, string][]>): string[] {
  const idSet = new Set(nodeIds);
  const degree = (id: string) => (adjacency.get(id) ?? []).length;
  const remaining = [...nodeIds].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const start of remaining) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      out.push(id);
      const next = (adjacency.get(id) ?? [])
        .map(([a, b]) => (a === id ? b : a))
        .filter((n) => idSet.has(n) && !seen.has(n))
        .sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1));
      for (const n of next) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rank wrapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Rank {
  /** dagre's rank-axis centre (x for LR, y for TB). */
  pos: number;
  /** Nodes in dagre's cross-axis order. */
  nodes: Center[];
}

/** Extents of a node along the rank axis (`main`) and the cross axis (`cross`). */
function extents(s: SizedNode, direction: Direction): { main: number; cross: number } {
  return direction === 'LR' ? { main: s.width, cross: s.height } : { main: s.height, cross: s.width };
}

function groupRanks(centers: Center[], direction: Direction): Rank[] {
  const byPos = new Map<number, Center[]>();
  for (const c of centers) {
    const pos = Math.round(direction === 'LR' ? c.cx : c.cy);
    const list = byPos.get(pos);
    if (list) list.push(c);
    else byPos.set(pos, [c]);
  }
  const crossOf = (c: Center) => (direction === 'LR' ? c.cy : c.cx);
  return [...byPos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pos, nodes]) => ({ pos, nodes: nodes.sort((a, b) => crossOf(a) - crossOf(b)) }));
}

/** Splits a rank into consecutive chunks whose stacked cross length stays within `limit`. */
function chunk(rank: Rank, sizes: Map<string, SizedNode>, direction: Direction, limit: number): Center[][] {
  const chunks: Center[][] = [];
  let current: Center[] = [];
  let length = 0;
  for (const c of rank.nodes) {
    const cross = extents(sizes.get(c.id)!, direction).cross;
    const next = current.length ? length + NODE_SEP + cross : cross;
    if (current.length && next > limit) {
      chunks.push(current);
      current = [c];
      length = cross;
    } else {
      current.push(c);
      length = next;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function stackLength(rank: Rank, sizes: Map<string, SizedNode>, direction: Direction): number {
  let sum = 0;
  for (const c of rank.nodes) sum += extents(sizes.get(c.id)!, direction).cross;
  return sum + NODE_SEP * Math.max(0, rank.nodes.length - 1);
}

type Placed = { nodes: { id: string; x: number; y: number }[]; main: number; cross: number };

/** dagre's own positions (top-left), with ranks in dagre's order. */
function placeOriginal(ranks: Rank[], sizes: Map<string, SizedNode>, direction: Direction): Placed {
  const nodes: { id: string; x: number; y: number }[] = [];
  let minMain = Infinity;
  let maxMain = -Infinity;
  let minCross = Infinity;
  let maxCross = -Infinity;
  for (const r of ranks) {
    for (const c of r.nodes) {
      const s = sizes.get(c.id)!;
      const x = c.cx - s.width / 2;
      const y = c.cy - s.height / 2;
      nodes.push({ id: c.id, x, y });
      const [m0, m1, c0, c1] = direction === 'LR' ? [x, x + s.width, y, y + s.height] : [y, y + s.height, x, x + s.width];
      minMain = Math.min(minMain, m0);
      maxMain = Math.max(maxMain, m1);
      minCross = Math.min(minCross, c0);
      maxCross = Math.max(maxCross, c1);
    }
  }
  return { nodes, main: Math.max(0, maxMain - minMain), cross: Math.max(0, maxCross - minCross) };
}

/**
 * Compact arrangement: every rank is stacked tightly in dagre's order (which minimises crossings) and
 * wrapped into sub-columns (LR) / sub-rows (TB) when longer than `limit`; stacks are centred on the
 * cross axis. Used when dagre's own result is far too elongated or sparse.
 */
function placeCompact(ranks: Rank[], sizes: Map<string, SizedNode>, direction: Direction, limit: number): Placed {
  const columns: { width: number; length: number; nodes: Center[]; gapAfter: number }[] = [];
  for (const rank of ranks) {
    const parts = chunk(rank, sizes, direction, limit);
    parts.forEach((part, i) => {
      let width = 0;
      let length = 0;
      for (const c of part) {
        const e = extents(sizes.get(c.id)!, direction);
        width = Math.max(width, e.main);
        length += e.cross;
      }
      length += NODE_SEP * Math.max(0, part.length - 1);
      columns.push({ width, length, nodes: part, gapAfter: i === parts.length - 1 ? RANK_SEP : WRAP_SEP });
    });
  }
  const cross = Math.max(0, ...columns.map((c) => c.length));
  const nodes: { id: string; x: number; y: number }[] = [];
  let cursor = 0;
  for (const col of columns) {
    let crossCursor = (cross - col.length) / 2;
    for (const c of col.nodes) {
      const e = extents(sizes.get(c.id)!, direction);
      const mainStart = cursor + (col.width - e.main) / 2;
      nodes.push(direction === 'LR' ? { id: c.id, x: mainStart, y: crossCursor } : { id: c.id, x: crossCursor, y: mainStart });
      crossCursor += e.cross + NODE_SEP;
    }
    cursor += col.width + col.gapAfter;
  }
  const last = columns[columns.length - 1];
  return { nodes, main: Math.max(0, cursor - (last?.gapAfter ?? 0)), cross };
}

/** Keeps dagre's result when it is reasonably shaped; otherwise picks the best compact wrapping. */
function arrange(centers: Center[], sizes: Map<string, SizedNode>, direction: Direction) {
  const ranks = groupRanks(centers, direction);
  let cardArea = 0;
  let longest = 0;
  let biggestNode = 0;
  for (const r of ranks) {
    longest = Math.max(longest, stackLength(r, sizes, direction));
    for (const c of r.nodes) {
      const s = sizes.get(c.id)!;
      cardArea += s.width * s.height;
      biggestNode = Math.max(biggestNode, extents(s, direction).cross);
    }
  }
  const aspectOf = (p: Placed) => {
    const width = direction === 'LR' ? p.main : p.cross;
    const height = direction === 'LR' ? p.cross : p.main;
    return Math.max(width, 1) / Math.max(height, 1);
  };
  const score = (p: Placed) => Math.abs(Math.log(aspectOf(p) / TARGET_ASPECT));
  const density = (p: Placed) => cardArea / Math.max(1, p.main * p.cross);

  const original = placeOriginal(ranks, sizes, direction);
  if (score(original) <= Math.log(2.5) && density(original) >= MIN_DENSITY) return original.nodes;

  let best = placeCompact(ranks, sizes, direction, Infinity);
  let bestScore = score(best);
  const steps = 16;
  for (let i = 1; i <= steps && longest > biggestNode; i++) {
    const limit = longest * Math.pow(biggestNode / longest, i / steps);
    const candidate = placeCompact(ranks, sizes, direction, Math.max(limit, biggestNode));
    const s = score(candidate);
    if (s < bestScore - 0.02) {
      best = candidate;
      bestScore = s;
    }
  }
  return best.nodes;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Components and packing
// ─────────────────────────────────────────────────────────────────────────────────────────────

function normalise(nodes: { id: string; x: number; y: number }[], sizes: Map<string, SizedNode>): Block {
  let minX = Infinity;
  let minY = Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
  }
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
    const s = sizes.get(n.id)!;
    maxX = Math.max(maxX, n.x + s.width);
    maxY = Math.max(maxY, n.y + s.height);
  }
  return { width: maxX, height: maxY, nodes };
}

/** Lays out one connected component and returns a block normalised to origin (0,0). */
function layoutComponent(
  nodeIds: readonly string[],
  sizes: Map<string, SizedNode>,
  adjacency: Map<string, [string, string][]>,
  direction: Direction,
): Block {
  const centers = dagreCenters(nodeIds, sizes, adjacency, direction);
  if (!centers) return packIsolated(neighbourOrder(nodeIds, adjacency), sizes); // dagre failed: keep neighbours close
  return normalise(arrange(centers, sizes, direction), sizes);
}

/** Packs nodes (in the given order) into a compact grid block. */
function packIsolated(nodeIds: readonly string[], sizes: Map<string, SizedNode>): Block {
  const list = nodeIds.map((id) => sizes.get(id)!);
  const cellW = Math.max(...list.map((s) => s.width), 1);
  const cols = Math.max(1, Math.round(Math.sqrt(list.length * TARGET_ASPECT * 0.6)));
  const nodes: { id: string; x: number; y: number }[] = [];
  const rowHeights: number[] = [];
  let maxW = 0;
  for (let i = 0; i < list.length; i++) {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, list[i].height);
  }
  const rowY: number[] = [];
  let y = 0;
  for (let r = 0; r < rowHeights.length; r++) {
    rowY[r] = y;
    y += rowHeights[r] + ISOLATED_GAP;
  }
  for (let i = 0; i < list.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = col * (cellW + ISOLATED_GAP);
    nodes.push({ id: list[i].id, x, y: rowY[row] });
    maxW = Math.max(maxW, x + list[i].width);
  }
  return { width: maxW, height: Math.max(0, y - ISOLATED_GAP), nodes };
}

/** Shelf packer: places blocks left→right, wrapping when a row exceeds `targetWidth`. */
function packShelves(blocks: Block[], targetWidth: number, gap: number): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let totalWidth = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > targetWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    for (const n of block.nodes) positions.set(n.id, { x: x + n.x, y: y + n.y });
    x += block.width + gap;
    rowHeight = Math.max(rowHeight, block.height);
    totalWidth = Math.max(totalWidth, x - gap);
  }
  return { positions, width: totalWidth, height: y + rowHeight };
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const sizes = new Map<string, SizedNode>();
  for (const n of input.nodes) sizes.set(n.id, n);

  const adjacency = new Map<string, [string, string][]>();
  const pairs: [string, string][] = [];
  for (const [a, b] of input.edges) {
    if (a === b || !sizes.has(a) || !sizes.has(b)) continue;
    pairs.push([a, b]);
    let la = adjacency.get(a);
    if (!la) adjacency.set(a, (la = []));
    la.push([a, b]);
    let lb = adjacency.get(b);
    if (!lb) adjacency.set(b, (lb = []));
    lb.push([a, b]);
  }

  const ids = input.nodes.map((n) => n.id);
  const components = connectedComponents(ids, pairs);

  const connectedBlocks: Block[] = [];
  const isolated: string[] = [];
  for (const comp of components) {
    if (comp.length === 1) isolated.push(comp[0]);
    else connectedBlocks.push(layoutComponent(comp, sizes, adjacency, input.direction));
  }

  // Largest first.
  connectedBlocks.sort((a, b) => b.width * b.height - a.width * a.height);
  const blocks = [...connectedBlocks];
  if (isolated.length) blocks.push(packIsolated(isolated, sizes));

  if (!blocks.length) return { positions: new Map(), width: 0, height: 0 };

  const maxBlockWidth = Math.max(...blocks.map((b) => b.width));
  const totalArea = blocks.reduce((sum, b) => sum + b.width * b.height, 0);
  // Aim for a landscape-ish arrangement.
  const targetWidth = Math.max(maxBlockWidth, Math.sqrt(totalArea) * TARGET_ASPECT);
  return packShelves(blocks, targetWidth, COMPONENT_GAP);
}
