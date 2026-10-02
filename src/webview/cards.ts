/**
 * Renders an entity as an SVG card. Pure DOM construction (createElementNS + textContent); no model
 * text ever reaches innerHTML.
 */

import type { Entity } from '../core/model';
import { columnType, qualifiedName } from '../core/format';
import { svg, svgText } from './dom';
import { kindGlyph, kindIcon } from './icons';
import type { CardMetrics } from './cardLayout';
import { HEADER_H, MORE_H, PAD_X, KEY_COL_W, ROW_H } from './cardLayout';

export interface CardHandles {
  group: SVGGElement;
  /** Row background rects keyed by column name (for row-level highlight). */
  rows: Map<string, SVGRectElement>;
  moreRow?: SVGGElement;
}

const KEY_CLASS: Record<string, string> = { PK: 'key-pk', FK: 'key-fk', UK: 'key-uk' };

export function createCard(metrics: CardMetrics, accentClass: string | undefined): CardHandles {
  const e: Entity = metrics.entity;
  const group = svg('g', {
    class: `node${e.external ? ' node-external' : ''}${e.joinTable ? ' node-join' : ''}`,
    'data-id': e.id,
    tabindex: '0',
    role: 'button',
  });
  group.setAttribute(
    'aria-label',
    `${qualifiedName(e)}, ${e.columns.length} column${e.columns.length === 1 ? '' : 's'}`,
  );

  const bg = svg('rect', {
    class: 'card-bg',
    x: 0,
    y: 0,
    width: metrics.width,
    height: metrics.height,
    rx: 6,
    ry: 6,
  });
  group.appendChild(bg);

  if (accentClass) {
    const accent = svg('rect', { class: `card-accent ${accentClass}`, x: 1, y: 1, width: metrics.width - 2, height: 4, rx: 2, ry: 2 });
    group.appendChild(accent);
  }

  // Header
  const header = svg('g', { class: 'card-header' });
  header.appendChild(kindIcon(kindGlyph(e), PAD_X, (HEADER_H - 14) / 2 + 1, 15));
  const titleX = PAD_X + 20;
  const title = svgText(e.name, { class: 'card-title', x: titleX, y: HEADER_H / 2 });
  title.setAttribute('dominant-baseline', 'central');
  header.appendChild(title);
  if (e.schema) {
    const badge = svg('g', { class: 'card-schema' });
    const bt = svgText(e.schema, { x: metrics.width - PAD_X, y: HEADER_H / 2, class: 'card-schema-text', 'text-anchor': 'end' });
    bt.setAttribute('dominant-baseline', 'central');
    badge.appendChild(bt);
    header.appendChild(badge);
  }
  group.appendChild(header);
  group.appendChild(svg('line', { class: 'card-sep', x1: 0, y1: HEADER_H, x2: metrics.width, y2: HEADER_H }));

  const rows = new Map<string, SVGRectElement>();
  const typeX = metrics.width - PAD_X;
  const nameX = PAD_X + KEY_COL_W;
  for (const r of metrics.rows) {
    const c = r.column;
    const g = svg('g', { class: 'row', 'data-col': c.name });
    const rowBg = svg('rect', { class: 'row-bg', x: 1, y: r.top, width: metrics.width - 2, height: ROW_H });
    g.appendChild(rowBg);
    rows.set(c.name, rowBg);

    if (r.keys.length) {
      let kx = PAD_X;
      for (const k of r.keys) {
        const kt = svgText(k, { class: `row-key ${KEY_CLASS[k] ?? ''}`, x: kx, y: r.centerY });
        kt.setAttribute('dominant-baseline', 'central');
        g.appendChild(kt);
        kx += k.length === 2 ? 20 : 24;
      }
    }

    const nm = svgText(c.name, {
      class: `row-name${c.primaryKey ? ' is-pk' : ''}`,
      x: r.keys.length ? nameX : PAD_X,
      y: r.centerY,
    });
    nm.setAttribute('dominant-baseline', 'central');
    g.appendChild(nm);

    const typeStr = columnType(c) + (c.nullable && !c.primaryKey ? ' ?' : '');
    const tp = svgText(typeStr, {
      class: `row-type${c.enumRef ? ' is-enum' : ''}`,
      x: typeX,
      y: r.centerY,
      'text-anchor': 'end',
    });
    tp.setAttribute('dominant-baseline', 'central');
    if (c.enumRef) tp.appendChild(svg('title', {}, [`enum`]));
    g.appendChild(tp);

    group.appendChild(g);
  }

  let moreRow: SVGGElement | undefined;
  if (metrics.hiddenCount > 0 && metrics.moreTop !== undefined) {
    moreRow = svg('g', { class: 'row row-more', 'data-more': '1' });
    const mbg = svg('rect', { class: 'row-bg', x: 1, y: metrics.moreTop, width: metrics.width - 2, height: MORE_H });
    moreRow.appendChild(mbg);
    const mt = svgText(`+${metrics.hiddenCount} more`, { class: 'row-more-text', x: PAD_X, y: metrics.moreTop + MORE_H / 2 });
    mt.setAttribute('dominant-baseline', 'central');
    moreRow.appendChild(mt);
    group.appendChild(moreRow);
  }

  return { group, rows, moreRow };
}
