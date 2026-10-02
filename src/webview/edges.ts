/**
 * Renders a relation as an SVG edge: a smooth curve between row anchors, crow's-foot cardinality
 * markers at both ends, dashed for inferred, a distinct style + "via x" label for many-to-many,
 * and a loop for self-relations.
 */

import type { Relation } from '../core/model';
import { CARDINALITY_LABELS } from '../core/format';
import { svg, svgText } from './dom';
import {
  chooseSides,
  edgePath,
  endpointMarker,
  selfLoopPath,
  sideAnchor,
  type EndStyle,
  type Rect,
} from './geometry';
import type { CardMetrics } from './cardLayout';
import type { DrawEdge } from './graphModel';

export interface Pos {
  x: number;
  y: number;
}

export interface EdgeView {
  edge: DrawEdge;
  group: SVGGElement;
  line: SVGPathElement;
  fromId: string;
  toId: string;
  fromCol?: string;
  toCol?: string;
  update(fromPos: Pos, toPos: Pos): void;
}

function endStyles(edge: DrawEdge): { from: EndStyle; to: EndStyle } {
  const r = edge.relation;
  if (edge.variant === 'm2m') return { from: 'zero-or-many', to: 'zero-or-many' };
  return {
    from: r.cardinality === 'one-to-one' ? 'zero-or-one' : 'zero-or-many',
    to: r.optional ? 'zero-or-one' : 'one',
  };
}

function tooltip(r: Relation, nameOf: (id: string) => string): string {
  const parts: string[] = [];
  const cols = (cs: readonly string[]) => (cs.length ? cs.join(', ') : '?');
  if (r.cardinality === 'many-to-many') {
    parts.push(`${nameOf(r.from)} ↔ ${nameOf(r.to)} (many-to-many${r.throughName ? ` via ${r.throughName}` : ''})`);
  } else {
    parts.push(`${nameOf(r.from)}.${cols(r.fromColumns)} → ${nameOf(r.to)}.${cols(r.toColumns)} (${CARDINALITY_LABELS[r.cardinality]})`);
  }
  parts.push(r.kind === 'inferred' ? 'inferred relation' : r.kind === 'orm' ? 'ORM association' : 'foreign key');
  if (r.optional) parts.push('optional');
  if (r.onDelete) parts.push(`on delete ${r.onDelete}`);
  return parts.join('\n');
}

export function createEdge(
  edge: DrawEdge,
  fromMetrics: CardMetrics,
  toMetrics: CardMetrics,
  nameOf: (id: string) => string,
): EdgeView {
  const r = edge.relation;
  const kindClass = edge.variant === 'm2m' ? 'edge-m2m' : r.kind === 'inferred' ? 'edge-inferred' : r.kind === 'orm' ? 'edge-orm' : 'edge-fk';
  const group = svg('g', { class: `edge ${kindClass}`, 'data-id': edge.id });
  group.appendChild(svg('title', {}, [tooltip(r, nameOf)]));

  const hit = svg('path', { class: 'edge-hit', d: '' });
  const line = svg('path', { class: 'edge-line', d: '' });
  const mFrom = svg('path', { class: 'edge-marker', d: '' });
  const mTo = svg('path', { class: 'edge-marker', d: '' });
  const cFrom = svg('circle', { class: 'edge-circle', r: '0', cx: '0', cy: '0' });
  const cTo = svg('circle', { class: 'edge-circle', r: '0', cx: '0', cy: '0' });
  group.append(hit, line, mFrom, mTo, cFrom, cTo);

  let label: SVGTextElement | undefined;
  if (edge.variant === 'm2m' && r.throughName) {
    label = svgText(`via ${r.throughName}`, { class: 'edge-label', x: '0', y: '0', 'text-anchor': 'middle' });
    group.appendChild(label);
  }

  const styles = endStyles(edge);
  const fromCol = r.fromColumns[0];
  const toCol = r.toColumns[0];

  const update = (fromPos: Pos, toPos: Pos): void => {
    const fromRect: Rect = { x: fromPos.x, y: fromPos.y, width: fromMetrics.width, height: fromMetrics.height };
    const toRect: Rect = { x: toPos.x, y: toPos.y, width: toMetrics.width, height: toMetrics.height };

    if (edge.self) {
      const y = fromPos.y + fromMetrics.anchorY(fromCol ?? '');
      const d = selfLoopPath(fromRect, y);
      hit.setAttribute('d', d);
      line.setAttribute('d', d);
      const a = { x: fromRect.x + fromRect.width, y: y - 14 };
      const b = { x: fromRect.x + fromRect.width, y: y + 14 };
      const mf = endpointMarker(a, 'right', styles.from);
      const mt = endpointMarker(b, 'right', styles.to);
      mFrom.setAttribute('d', mf.path);
      mTo.setAttribute('d', mt.path);
      setCircle(cFrom, mf.circle);
      setCircle(cTo, mt.circle);
      if (label) {
        label.setAttribute('x', String(fromRect.x + fromRect.width + 50));
        label.setAttribute('y', String(y));
      }
      return;
    }

    const { fromSide, toSide } = chooseSides(fromRect, toRect);
    const a = sideAnchor(fromRect, fromSide, fromPos.y + fromMetrics.anchorY(fromCol ?? ''));
    const b = sideAnchor(toRect, toSide, toPos.y + toMetrics.anchorY(toCol ?? ''));
    const d = edgePath(a, fromSide, b, toSide);
    hit.setAttribute('d', d);
    line.setAttribute('d', d);

    const mf = endpointMarker(a, fromSide, styles.from);
    const mt = endpointMarker(b, toSide, styles.to);
    mFrom.setAttribute('d', mf.path);
    mTo.setAttribute('d', mt.path);
    setCircle(cFrom, mf.circle);
    setCircle(cTo, mt.circle);

    if (label) {
      label.setAttribute('x', String((a.x + b.x) / 2));
      label.setAttribute('y', String((a.y + b.y) / 2 - 4));
    }
  };

  return { edge, group, line, fromId: edge.from, toId: edge.to, fromCol, toCol, update };
}

function setCircle(c: SVGCircleElement, circle?: { cx: number; cy: number; r: number }): void {
  if (circle) {
    c.setAttribute('cx', String(circle.cx));
    c.setAttribute('cy', String(circle.cy));
    c.setAttribute('r', String(circle.r));
  } else {
    c.setAttribute('r', '0');
  }
}
