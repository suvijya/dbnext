import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  chooseSides,
  edgePath,
  endpointMarker,
  outward,
  rectCenter,
  rectsOverlap,
  selfLoopPath,
  sideAnchor,
  type Rect,
} from '../../../src/webview/geometry';

const rect = (x: number, y: number, width = 100, height = 60): Rect => ({ x, y, width, height });

describe('geometry anchors', () => {
  it('rectCenter is the middle of the rectangle', () => {
    expect(rectCenter(rect(0, 0, 100, 60))).toEqual({ x: 50, y: 30 });
  });

  it('sideAnchor lands on the requested edge, honouring the row y', () => {
    const r = rect(10, 20, 100, 60);
    expect(sideAnchor(r, 'right', 55)).toEqual({ x: 110, y: 55 });
    expect(sideAnchor(r, 'left', 55)).toEqual({ x: 10, y: 55 });
    expect(sideAnchor(r, 'top')).toEqual({ x: 60, y: 20 });
    expect(sideAnchor(r, 'bottom')).toEqual({ x: 60, y: 80 });
  });

  it('outward vectors point away from the node', () => {
    expect(outward('right')).toEqual({ x: 1, y: 0 });
    expect(outward('left')).toEqual({ x: -1, y: 0 });
    expect(outward('top')).toEqual({ x: 0, y: -1 });
    expect(outward('bottom')).toEqual({ x: 0, y: 1 });
  });
});

describe('chooseSides', () => {
  it('exits right / enters left when the target is to the right', () => {
    expect(chooseSides(rect(0, 0), rect(300, 0))).toEqual({ fromSide: 'right', toSide: 'left' });
  });
  it('exits left / enters right when the target is to the left', () => {
    expect(chooseSides(rect(300, 0), rect(0, 0))).toEqual({ fromSide: 'left', toSide: 'right' });
  });
});

describe('edgePath', () => {
  it('is a cubic bezier from a to b', () => {
    const d = edgePath({ x: 0, y: 0 }, 'right', { x: 200, y: 100 }, 'left');
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d).toContain('C');
    expect(d.trim().endsWith('200 100')).toBe(true);
  });
  it('self loop returns to the same side', () => {
    const d = selfLoopPath(rect(0, 0, 100, 60), 30);
    expect(d.startsWith('M 100')).toBe(true);
    expect(d).toContain('C');
  });
});

describe('endpointMarker', () => {
  it('many has three prongs and no circle', () => {
    const m = endpointMarker({ x: 100, y: 50 }, 'right', 'many');
    expect(m.path.match(/M /g)?.length).toBe(3);
    expect(m.circle).toBeUndefined();
  });
  it('one is a single bar with no circle', () => {
    const m = endpointMarker({ x: 100, y: 50 }, 'right', 'one');
    expect(m.path.match(/M /g)?.length).toBe(1);
    expect(m.circle).toBeUndefined();
  });
  it('zero-or-one adds the optional circle', () => {
    const m = endpointMarker({ x: 100, y: 50 }, 'right', 'zero-or-one');
    expect(m.circle).toBeDefined();
    expect(m.circle!.cx).toBeGreaterThan(100);
  });
  it('zero-or-many has the crow foot and a circle', () => {
    const m = endpointMarker({ x: 100, y: 50 }, 'right', 'zero-or-many');
    expect(m.path.match(/M /g)?.length).toBe(3);
    expect(m.circle).toBeDefined();
  });
});

describe('bounds & overlap', () => {
  it('boundsOf covers all rectangles', () => {
    expect(boundsOf([rect(0, 0, 100, 60), rect(200, 100, 50, 50)])).toEqual({ x: 0, y: 0, width: 250, height: 150 });
  });
  it('boundsOf is null when empty', () => {
    expect(boundsOf([])).toBeNull();
  });
  it('rectsOverlap detects intersections and gaps', () => {
    expect(rectsOverlap(rect(0, 0, 100, 60), rect(50, 20, 100, 60))).toBe(true);
    expect(rectsOverlap(rect(0, 0, 100, 60), rect(200, 0, 100, 60))).toBe(false);
  });
});
