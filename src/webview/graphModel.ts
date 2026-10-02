/**
 * Pure derivation of the drawable graph from a SchemaModel + current filters.
 * No DOM — unit tested in test/unit/webview.
 */

import type { Entity, Relation, SchemaModel } from '../core/model';
import type { Filters } from './types';

export const DEFAULT_SCHEMA = '(default)';

export function schemaKey(e: Pick<Entity, 'schema'>): string {
  return e.schema ?? DEFAULT_SCHEMA;
}

/** A relation as it should be drawn. `variant` 'm2m' is a direct many-to-many link (no join node). */
export interface DrawEdge {
  id: string;
  relation: Relation;
  from: string;
  to: string;
  variant: 'relation' | 'm2m';
  self: boolean;
}

export interface VisibleGraph {
  /** Ids of entities that should be rendered. */
  ids: Set<string>;
  /** Rendered entities, in model order. */
  entities: Entity[];
  edges: DrawEdge[];
  /** Undirected neighbour map over the drawn edges. */
  neighbors: Map<string, Set<string>>;
}

function attributeVisible(e: Entity, filters: Filters): boolean {
  if (filters.hideExternal && e.external) return false;
  if (filters.hideJoinTables && e.joinTable) return false;
  if (filters.disabledSchemas.includes(schemaKey(e))) return false;
  if (e.engine && filters.disabledEngines.includes(e.engine)) return false;
  if (e.sources.length && e.sources.every((s) => filters.disabledSources.includes(s))) return false;
  return true;
}

function addNeighbor(map: Map<string, Set<string>>, a: string, b: string): void {
  let s = map.get(a);
  if (!s) map.set(a, (s = new Set()));
  s.add(b);
}

/** Entities reachable from `start` within `hops` steps over the undirected edge graph. */
export function withinHops(neighbors: Map<string, Set<string>>, start: string, hops: number): Set<string> {
  const reached = new Set<string>([start]);
  let frontier = [start];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of neighbors.get(id) ?? []) {
        if (!reached.has(n)) {
          reached.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return reached;
}

/**
 * Computes the set of visible entities and the edges to draw given the active filters and (for
 * focus mode) the current selection.
 */
export function computeVisibleGraph(
  model: Pick<SchemaModel, 'entities' | 'relations'>,
  filters: Filters,
  selection: string | null,
): VisibleGraph {
  const ids = new Set<string>();
  for (const e of model.entities) if (attributeVisible(e, filters)) ids.add(e.id);

  const edges: DrawEdge[] = [];
  for (const r of model.relations) {
    if (filters.hideInferred && r.kind === 'inferred') continue;
    if (!ids.has(r.from) || !ids.has(r.to)) continue;
    if (r.cardinality === 'many-to-many') {
      // Drawn through its join table when that is visible; otherwise a direct ↔ edge.
      if (r.through && ids.has(r.through)) continue;
      edges.push({ id: `${r.id}~m2m`, relation: r, from: r.from, to: r.to, variant: 'm2m', self: r.from === r.to });
    } else {
      edges.push({ id: r.id, relation: r, from: r.from, to: r.to, variant: 'relation', self: r.from === r.to });
    }
  }

  const neighbors = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.self) continue;
    addNeighbor(neighbors, e.from, e.to);
    addNeighbor(neighbors, e.to, e.from);
  }

  // Focus mode: keep only the selection and its N-hop neighbourhood.
  if (filters.focusHops > 0 && selection && ids.has(selection)) {
    const keep = withinHops(neighbors, selection, filters.focusHops);
    for (const id of [...ids]) if (!keep.has(id)) ids.delete(id);
    const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    edges.length = 0;
    edges.push(...kept);
    neighbors.clear();
    for (const e of edges) {
      if (e.self) continue;
      addNeighbor(neighbors, e.from, e.to);
      addNeighbor(neighbors, e.to, e.from);
    }
  }

  const entities = model.entities.filter((e) => ids.has(e.id));
  return { ids, entities, edges, neighbors };
}

/** Connected components over a set of node ids and undirected edge pairs. Largest first. */
export function connectedComponents(
  ids: readonly string[],
  edgePairs: readonly [string, string][],
): string[][] {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [a, b] of edgePairs) {
    if (parent.has(a) && parent.has(b)) union(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/** Degree (number of distinct neighbours) of every entity, for "most connected" ranking. */
export function degrees(model: Pick<SchemaModel, 'relations'>): Map<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const r of model.relations) {
    if (r.from === r.to) continue;
    addNeighbor(neighbors, r.from, r.to);
    addNeighbor(neighbors, r.to, r.from);
  }
  const out = new Map<string, number>();
  for (const [id, s] of neighbors) out.set(id, s.size);
  return out;
}
