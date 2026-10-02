import { describe, expect, it } from 'vitest';
import { computeLayout, type SizedNode } from '../../../src/webview/layout';
import { rectsOverlap, type Rect } from '../../../src/webview/geometry';

const node = (id: string, width = 160, height = 90): SizedNode => ({ id, width, height });

describe('computeLayout', () => {
  it('positions every node and reports a bounding size', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const res = computeLayout({ nodes, edges: [['a', 'b'], ['b', 'c']], direction: 'LR' });
    expect(res.positions.size).toBe(3);
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
    for (const n of nodes) expect(Number.isFinite(res.positions.get(n.id)!.x)).toBe(true);
  });

  it('does not overlap connected nodes', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const res = computeLayout({ nodes, edges: [['a', 'b'], ['a', 'c'], ['a', 'd']], direction: 'LR' });
    const rects: Rect[] = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('separates disconnected components into their own packed blocks', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const res = computeLayout({ nodes, edges: [['a', 'b']], direction: 'LR' });
    const rects: Rect[] = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('handles an empty graph', () => {
    const res = computeLayout({ nodes: [], edges: [], direction: 'TB' });
    expect(res.positions.size).toBe(0);
    expect(res.width).toBe(0);
  });

  it('packs many isolated nodes compactly without overlap', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`));
    const res = computeLayout({ nodes, edges: [], direction: 'LR' });
    const rects: Rect[] = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('handles parallel edges, reverse edges and cycles (real schemas)', () => {
    const nodes = [node('users'), node('teams'), node('bookings'), ...Array.from({ length: 30 }, (_, i) => node(`t${i}`, 160, 60 + (i % 5) * 20))];
    const edges: [string, string][] = [];
    for (let i = 0; i < 30; i++) {
      edges.push([`t${i}`, 'users'], [`t${i}`, 'users'], [`t${i}`, i % 2 ? 'teams' : 'bookings']);
      if (i % 3 === 0) edges.push(['users', `t${i}`]); // reverse edge → 2-cycle
    }
    edges.push(['bookings', 'users'], ['users', 'bookings'], ['teams', 'teams']);
    for (const direction of ['LR', 'TB'] as const) {
      const res = computeLayout({ nodes, edges, direction });
      const rects = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
      for (const r of rects) expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
    }
  });

  it('wraps a hub with many dependants into a landscape-ish block instead of one long strip', () => {
    const nodes = [node('accounts', 200, 600), ...Array.from({ length: 80 }, (_, i) => node(`dep${i}`, 200, 120))];
    const edges = nodes.slice(1).map((n) => [n.id, 'accounts'] as [string, string]);
    for (const direction of ['LR', 'TB'] as const) {
      const res = computeLayout({ nodes, edges, direction });
      const aspect = res.width / res.height;
      expect(aspect, direction).toBeGreaterThan(0.6);
      expect(aspect, direction).toBeLessThan(4);
      const rects = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
    }
  });
});
