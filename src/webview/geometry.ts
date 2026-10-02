/**
 * Pure 2-D geometry for the diagram: node rectangles, edge anchors, smooth orthogonal-ish edge
 * paths and crow's-foot cardinality markers. No DOM — unit tested in test/unit/webview.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  /** Top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Crow's-foot end style (which cardinality symbol sits at an endpoint). */
export type EndStyle = 'one' | 'many' | 'zero-or-one' | 'zero-or-many';

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Anchor point on a side of a rectangle. For left/right, `at` overrides the vertical position. */
export function sideAnchor(r: Rect, side: Side, at?: number): Point {
  switch (side) {
    case 'left':
      return { x: r.x, y: at ?? r.y + r.height / 2 };
    case 'right':
      return { x: r.x + r.width, y: at ?? r.y + r.height / 2 };
    case 'top':
      return { x: at ?? r.x + r.width / 2, y: r.y };
    case 'bottom':
      return { x: at ?? r.x + r.width / 2, y: r.y + r.height };
  }
}

/** Unit vector pointing away from the node through the given side. */
export function outward(side: Side): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
  }
}

/**
 * Decide which horizontal sides two cards connect through. ER edges attach to the left/right edges
 * of cards (where column rows live); the side nearest the other card is chosen.
 */
export function chooseSides(from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
  const toRight = rectCenter(to).x >= rectCenter(from).x;
  return toRight ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
}

/** Smooth cubic path between two anchors, bulging out of each node along its side. */
export function edgePath(a: Point, aSide: Side, b: Point, bSide: Side): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.max(24, Math.min(dist * 0.4, 180));
  const ao = outward(aSide);
  const bo = outward(bSide);
  const c1 = { x: a.x + ao.x * k, y: a.y + ao.y * k };
  const c2 = { x: b.x + bo.x * k, y: b.y + bo.y * k };
  return `M ${round(a.x)} ${round(a.y)} C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`;
}

/** Self-relation loop leaving and re-entering the right side of a card at height `y`. */
export function selfLoopPath(r: Rect, y: number): string {
  const x = r.x + r.width;
  const top = y - 14;
  const bottom = y + 14;
  const out = x + 46;
  return `M ${round(x)} ${round(top)} C ${round(out)} ${round(top)} ${round(out)} ${round(bottom)} ${round(x)} ${round(bottom)}`;
}

export interface MarkerShape {
  /** Lines of the symbol (crow's foot / tick). May be empty. */
  path: string;
  /** Optional "zero" circle. */
  circle?: { cx: number; cy: number; r: number };
}

const FOOT_LEN = 13;
const FOOT_SPREAD = 7;
const TICK_OFFSET = 9;
const TICK_HALF = 6;
const CIRCLE_R = 4;

/**
 * Crow's-foot (and tick / optional-circle) symbol for one endpoint.
 * `p` is the anchor on the node edge; `side` is the node side the edge leaves through.
 */
export function endpointMarker(p: Point, side: Side, style: EndStyle): MarkerShape {
  const u = outward(side);
  const perp = { x: -u.y, y: u.x };
  const many = style === 'many' || style === 'zero-or-many';
  const zero = style === 'zero-or-one' || style === 'zero-or-many';
  const parts: string[] = [];

  if (many) {
    const apex = { x: p.x + u.x * FOOT_LEN, y: p.y + u.y * FOOT_LEN };
    const t1 = { x: p.x + perp.x * FOOT_SPREAD, y: p.y + perp.y * FOOT_SPREAD };
    const t2 = { x: p.x - perp.x * FOOT_SPREAD, y: p.y - perp.y * FOOT_SPREAD };
    parts.push(
      `M ${round(apex.x)} ${round(apex.y)} L ${round(t1.x)} ${round(t1.y)}`,
      `M ${round(apex.x)} ${round(apex.y)} L ${round(p.x)} ${round(p.y)}`,
      `M ${round(apex.x)} ${round(apex.y)} L ${round(t2.x)} ${round(t2.y)}`,
    );
  } else {
    // "one": a single bar across the edge.
    const c = { x: p.x + u.x * TICK_OFFSET, y: p.y + u.y * TICK_OFFSET };
    const a = { x: c.x + perp.x * TICK_HALF, y: c.y + perp.y * TICK_HALF };
    const b = { x: c.x - perp.x * TICK_HALF, y: c.y - perp.y * TICK_HALF };
    parts.push(`M ${round(a.x)} ${round(a.y)} L ${round(b.x)} ${round(b.y)}`);
  }

  const shape: MarkerShape = { path: parts.join(' ') };
  if (zero) {
    const d = (many ? FOOT_LEN : TICK_OFFSET) + CIRCLE_R + 3;
    shape.circle = { cx: round(p.x + u.x * d), cy: round(p.y + u.y * d), r: CIRCLE_R };
  }
  return shape;
}

/** True when two rectangles overlap (used to nudge freshly laid-out nodes apart). */
export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x - pad < b.x + b.width &&
    a.x + a.width + pad > b.x &&
    a.y - pad < b.y + b.height &&
    a.y + a.height + pad > b.y
  );
}

/** Axis-aligned bounding box of a set of rectangles (null when empty). */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
