import { describe, expect, it } from 'vitest';
import type { Entity, Relation, SchemaModel } from '../../../src/core/model';
import {
  computeVisibleGraph,
  connectedComponents,
  degrees,
  withinHops,
} from '../../../src/webview/graphModel';
import { defaultFilters, type Filters } from '../../../src/webview/types';

const col = (name: string) => ({ name, type: 'int', nullable: true, primaryKey: false, unique: false });
const ent = (id: string, extra: Partial<Entity> = {}): Entity => ({
  id,
  name: id,
  kind: 'table',
  modelNames: [],
  columns: [col('id')],
  indexes: [],
  sources: ['sql'],
  files: [],
  ...extra,
});

const rel = (id: string, from: string, to: string, extra: Partial<Relation> = {}): Relation => ({
  id,
  from,
  fromColumns: ['x_id'],
  to,
  toColumns: ['id'],
  cardinality: 'many-to-one',
  kind: 'foreign-key',
  optional: false,
  sources: ['sql'],
  ...extra,
});

const model: Pick<SchemaModel, 'entities' | 'relations'> = {
  entities: [
    ent('users'),
    ent('posts'),
    ent('tags'),
    ent('post_tags', { joinTable: true }),
    ent('comments'),
    ent('ext', { external: true }),
  ],
  relations: [
    rel('r1', 'posts', 'users'),
    rel('r2', 'post_tags', 'posts'),
    rel('r3', 'post_tags', 'tags'),
    rel('r4', 'posts', 'tags', { cardinality: 'many-to-many', through: 'post_tags', throughName: 'post_tags' }),
    rel('r5', 'comments', 'users', { kind: 'inferred' }),
    rel('r6', 'posts', 'ext'),
  ],
};

const filters = (over: Partial<Filters> = {}): Filters => ({ ...defaultFilters(), ...over });

describe('computeVisibleGraph', () => {
  it('shows every entity and draws m2m through its visible join table (no direct m2m edge)', () => {
    const g = computeVisibleGraph(model, filters(), null);
    expect(g.ids.size).toBe(6);
    expect(g.edges).toHaveLength(5);
    expect(g.edges.some((e) => e.variant === 'm2m')).toBe(false);
  });

  it('hideExternal removes external entities and their edges', () => {
    const g = computeVisibleGraph(model, filters({ hideExternal: true }), null);
    expect(g.ids.has('ext')).toBe(false);
    expect(g.edges.some((e) => e.from === 'ext' || e.to === 'ext')).toBe(false);
  });

  it('hideInferred drops inferred relations', () => {
    const g = computeVisibleGraph(model, filters({ hideInferred: true }), null);
    expect(g.edges.some((e) => e.relation.kind === 'inferred')).toBe(false);
  });

  it('hideJoinTables removes the junction and draws a direct ↔ edge instead', () => {
    const g = computeVisibleGraph(model, filters({ hideJoinTables: true }), null);
    expect(g.ids.has('post_tags')).toBe(false);
    const m2m = g.edges.find((e) => e.variant === 'm2m');
    expect(m2m).toBeDefined();
    expect([m2m!.from, m2m!.to].sort()).toEqual(['posts', 'tags']);
  });

  it('focus mode keeps only the selection and its N-hop neighbourhood', () => {
    const g = computeVisibleGraph(model, filters({ focusHops: 1 }), 'users');
    expect([...g.ids].sort()).toEqual(['comments', 'posts', 'users']);
    expect(g.edges).toHaveLength(2);
  });
});

describe('connectedComponents', () => {
  it('groups connected ids and lists the largest first', () => {
    const comps = connectedComponents(['a', 'b', 'c', 'd'], [['a', 'b']]);
    expect(comps[0]).toEqual(['a', 'b']);
    expect(comps).toHaveLength(3);
  });
});

describe('degrees & withinHops', () => {
  it('counts distinct neighbours', () => {
    expect(degrees(model).get('users')).toBe(2);
  });

  it('withinHops expands breadth-first', () => {
    const n = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['a', 'c'])],
      ['c', new Set(['b'])],
    ]);
    expect([...withinHops(n, 'a', 1)].sort()).toEqual(['a', 'b']);
    expect([...withinHops(n, 'a', 2)].sort()).toEqual(['a', 'b', 'c']);
  });
});
