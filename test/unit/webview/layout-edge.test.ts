import { describe, expect, it } from 'vitest';
import { computeLayout, type SizedNode } from '../../../src/webview/layout';
import { clip } from '../../../src/webview/clip';

describe('large layouts', () => {
  it('lays out 1000 nodes / 3000 edges quickly without overlaps of identical cells', () => {
    let s = 7;
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const nodes: SizedNode[] = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, width: 200, height: 120 }));
    const edges: [string, string][] = [];
    for (let i = 0; i < 3000; i++) edges.push([`t${Math.floor(r() * 1000)}`, `t${Math.floor(r() * 1000)}`]);
    const t0 = Date.now();
    const res = computeLayout({ nodes, edges, direction: 'LR' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.positions.size).toBe(1000);
    const cells = new Set([...res.positions.values()].map((p) => `${p.x},${p.y}`));
    expect(cells.size).toBe(1000);
  });
});

describe('clip', () => {
  it('cuts long text code-point safely and neutralises control characters', () => {
    expect(clip('x'.repeat(300), 10)).toBe('x'.repeat(9) + '…');
    expect(clip('a\u0000b\nc')).toBe('a b c');
    expect(clip('🚀'.repeat(50), 5)).toBe('🚀🚀🚀🚀…');
  });
});

