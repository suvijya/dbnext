/**
 * Card geometry: given an entity, the column mode and the measurer, compute the card's size and the
 * vertical position of every visible row. Shared by the renderer (cards.ts), the edge router
 * (edges.ts) and the layout sizer so they always agree.
 */

import type { Column, Entity } from '../core/model';
import { columnKeys, columnType } from '../core/format';
import type { ColumnMode } from './types';
import type { Measurer } from './measure';

export const HEADER_H = 34;
export const ROW_H = 22;
export const MORE_H = 22;
export const PAD_X = 10;
export const KEY_COL_W = 34;
export const GAP = 10;
export const MIN_W = 148;
export const MAX_W = 360;
export const COLLAPSE_LIMIT = 15;
export const COLLAPSE_TO = 12;

export interface RowMetric {
  column: Column;
  /** Row top, relative to the card top. */
  top: number;
  centerY: number;
  keys: string[];
}

export interface CardMetrics {
  entity: Entity;
  width: number;
  height: number;
  headerHeight: number;
  rows: RowMetric[];
  /** Columns hidden behind the "+N more" row. */
  hiddenCount: number;
  moreTop?: number;
  /** Vertical centre to anchor edges to a given column (card centre when the column is hidden). */
  anchorY(columnName: string): number;
}

function visibleColumns(entity: Entity, mode: ColumnMode): Column[] {
  if (mode === 'none') return [];
  if (mode === 'keys') return entity.columns.filter((c) => columnKeys(c).length);
  return entity.columns;
}

export function computeCardMetrics(
  entity: Entity,
  mode: ColumnMode,
  expanded: boolean,
  m: Measurer,
): CardMetrics {
  const header = entity.schema ? `${entity.name}` : entity.name;
  const badge = entity.schema ?? '';
  let width = m.ui(header, 'bold') + 22 /* kind icon */ + (badge ? m.ui(badge) + 14 : 0) + PAD_X * 2 + 12;

  let cols = visibleColumns(entity, mode);
  let hiddenCount = 0;
  if (cols.length > COLLAPSE_LIMIT && !expanded) {
    hiddenCount = cols.length - COLLAPSE_TO;
    cols = cols.slice(0, COLLAPSE_TO);
  }

  const rows: RowMetric[] = [];
  let y = HEADER_H;
  for (const c of cols) {
    const keys = columnKeys(c);
    const nameW = m.ui(c.name);
    const typeW = m.mono(columnType(c));
    const rowW = PAD_X + (keys.length ? KEY_COL_W : 0) + nameW + GAP + typeW + 16 + PAD_X;
    width = Math.max(width, rowW);
    rows.push({ column: c, top: y, centerY: y + ROW_H / 2, keys });
    y += ROW_H;
  }

  let moreTop: number | undefined;
  if (hiddenCount > 0) {
    moreTop = y;
    width = Math.max(width, PAD_X * 2 + m.ui(`+${hiddenCount} more`) + 20);
    y += MORE_H;
  }

  width = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(width)));
  const height = Math.max(HEADER_H, y) + (rows.length || hiddenCount ? 6 : 0);

  const byName = new Map<string, number>();
  for (const r of rows) byName.set(r.column.name, r.centerY);
  const centerY = height / 2;

  return {
    entity,
    width,
    height,
    headerHeight: HEADER_H,
    rows,
    hiddenCount,
    moreTop,
    anchorY(columnName: string): number {
      const yy = byName.get(columnName);
      if (yy !== undefined) return yy;
      // Hidden column → anchor at the "+N more" row if present, else card centre.
      return moreTop !== undefined ? moreTop + MORE_H / 2 : centerY;
    },
  };
}
