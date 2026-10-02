import { describe, expect, it, vi } from 'vitest';

// dagre occasionally throws on real-world graphs ("Not possible to find intersection inside of the
// rectangle"); the diagram must still render every table.
vi.mock('@dagrejs/dagre', async (importOriginal) => {
  const real = (await importOriginal()) as { default: Record<string, unknown> };
  const layout = () => {
    throw new Error('Not possible to find intersection inside of the rectangle');
  };
  return { ...real, default: { ...real.default, layout }, layout };
});

import { computeLayout } from '../../../src/webview/layout';
import { rectsOverlap } from '../../../src/webview/geometry';

describe('computeLayout when dagre fails', () => {
  it('falls back to a neighbour-ordered grid without overlaps', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, width: 180, height: 80 + (i % 3) * 30 }));
    const edges = nodes.slice(1).map((n, i) => [n.id, i % 2 ? 'n0' : 'n1'] as [string, string]);
    const res = computeLayout({ nodes, edges, direction: 'LR' });
    expect(res.positions.size).toBe(12);
    const rects = nodes.map((n) => ({ ...res.positions.get(n.id)!, width: n.width, height: n.height }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
  });
});
