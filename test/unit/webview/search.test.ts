import { describe, expect, it } from 'vitest';
import type { Entity } from '../../../src/core/model';
import { buildSearchItems, matchedEntityIds, scoreItem, search } from '../../../src/webview/search';

const col = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: false, unique: false });
const entity = (id: string, name: string, cols: string[], schema?: string): Entity => ({
  id,
  name,
  ...(schema ? { schema } : {}),
  kind: 'table',
  modelNames: [],
  columns: cols.map(col),
  indexes: [],
  sources: ['sql'],
  files: [],
});

const entities: Entity[] = [
  entity('users', 'users', ['id', 'email', 'created_at']),
  entity('user_roles', 'user_roles', ['user_id', 'role_id']),
  entity('auth.sessions', 'sessions', ['id', 'user_id'], 'auth'),
];

describe('buildSearchItems', () => {
  it('creates one item per table (qualified) and one per column', () => {
    const items = buildSearchItems(entities);
    expect(items.filter((i) => i.kind === 'table').map((i) => i.label)).toEqual(['users', 'user_roles', 'auth.sessions']);
    expect(items.find((i) => i.kind === 'column' && i.column === 'email')?.label).toBe('users.email');
  });
});

describe('scoreItem', () => {
  const items = buildSearchItems(entities);
  const table = (label: string) => items.find((i) => i.kind === 'table' && i.label === label)!;

  it('ranks exact above prefix above fuzzy', () => {
    const exact = scoreItem(table('users'), 'users')!.score;
    const prefix = scoreItem(table('user_roles'), 'user')!.score;
    const fuzzy = scoreItem(table('user_roles'), 'usrol')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(fuzzy);
  });

  it('returns null when there is no match', () => {
    expect(scoreItem(table('users'), 'zzz')).toBeNull();
  });

  it('tables outrank columns for the same text', () => {
    const tHit = scoreItem(table('users'), 'users')!.score;
    const cItem = items.find((i) => i.kind === 'column' && i.label === 'auth.sessions.user_id')!;
    const cHit = scoreItem(cItem, 'user_id')!.score;
    expect(tHit).toBeGreaterThan(cHit);
  });

  it('produces highlight ranges covering the substring', () => {
    const hit = scoreItem(table('user_roles'), 'roles')!;
    const r = hit.ranges[0];
    expect('user_roles'.slice(r.start, r.end)).toBe('roles');
  });
});

describe('search', () => {
  const items = buildSearchItems(entities);

  it('empty query returns nothing', () => {
    expect(search(items, '   ')).toEqual([]);
  });

  it('matches columns across tables', () => {
    const hits = search(items, 'user_id');
    const labels = hits.map((h) => h.item.label);
    expect(labels).toContain('user_roles.user_id');
    expect(labels).toContain('auth.sessions.user_id');
  });

  it('matchedEntityIds is distinct and order-preserving', () => {
    const hits = search(items, 'user');
    const ids = matchedEntityIds(hits);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('users');
  });
});
