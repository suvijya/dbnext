/**
 * Inline SVG icons (16×16, currentColor). Built with createElementNS — no innerHTML.
 * Entity-kind icons return an SVG group for embedding in a card header; UI icons return a
 * standalone <svg> for toolbar buttons.
 */

import { svg } from './dom';
import type { EntityKind } from '../core/model';

export type KindGlyph = 'table' | 'view' | 'collection' | 'external' | 'join';

/** Standalone 16×16 icon for a toolbar button etc. */
export function icon(paths: string[], opts: { fill?: boolean; cls?: string } = {}): SVGSVGElement {
  const root = svg('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' });
  if (opts.cls) root.setAttribute('class', opts.cls);
  for (const d of paths) {
    root.appendChild(
      svg('path', {
        d,
        fill: opts.fill ? 'currentColor' : 'none',
        stroke: opts.fill ? 'none' : 'currentColor',
        'stroke-width': opts.fill ? undefined : '1.3',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }
  return root;
}

const PATHS = {
  search: ['M7 2.5a4.5 4.5 0 1 0 2.8 8.03l3.08 3.09 1.06-1.06-3.09-3.08A4.5 4.5 0 0 0 7 2.5Zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z'],
  fit: ['M2 2h4M2 2v4M14 2h-4M14 2v4M2 14h4M2 14v-4M14 14h-4M14 14v-4', 'M5.5 5.5h5v5h-5z'],
  plus: ['M8 3v10M3 8h10'],
  minus: ['M3 8h10'],
  reset: ['M3 8a5 5 0 1 1 1.5 3.5', 'M3 11.5V8H6.5'],
  relayout: ['M8 2.5v11M2.5 8h11', 'M4 4l2 2M12 4l-2 2M4 12l2-2M12 12l-2-2'],
  columns: ['M2.5 3h11v10h-11z', 'M6 3v10M10 3v10'],
  filter: ['M2.5 3.5h11l-4 5v4l-3 1.5v-5.5z'],
  direction: ['M2 8h9', 'M8 5l3 3-3 3', 'M14 3v10'],
  download: ['M8 2v8', 'M5 7l3 3 3-3', 'M3 13h10'],
  copy: ['M5.5 5.5h7v8h-7z', 'M3.5 10.5V2.5h7'],
  file: ['M4 2h5l3 3v9H4z', 'M9 2v3h3'],
  refresh: ['M12.5 7a4.5 4.5 0 1 0-.6 3.4', 'M12.5 3.5V7H9'],
  close: ['M4 4l8 8M12 4l-8 8'],
  chevronR: ['M6 4l4 4-4 4'],
  chevronD: ['M4 6l4 4 4-4'],
  log: ['M3 3h10v10H3z', 'M5.5 6h5M5.5 8.5h5M5.5 11h3'],
  menu: ['M3 4.5h10M3 8h10M3 11.5h7'],
  panel: ['M2.5 3h11v10h-11z', 'M10 3v10'],
  warning: ['M8 2.5l6 11H2z', 'M8 7v3M8 11.5v.5'],
  goto: ['M6 3h7v7', 'M13 3l-7 7', 'M3 6v7h7'],
} as const;

export type IconName = keyof typeof PATHS;

export function uiIcon(name: IconName, fill = false): SVGSVGElement {
  return icon([...PATHS[name]], { fill });
}

/** Returns the glyph key for an entity, matching the "kind" labels. */
export function kindGlyph(e: { kind: EntityKind; external?: boolean; joinTable?: boolean }): KindGlyph {
  if (e.external) return 'external';
  if (e.kind === 'view') return 'view';
  if (e.kind === 'collection') return 'collection';
  return e.joinTable ? 'join' : 'table';
}

const KIND_PATHS: Record<KindGlyph, string[]> = {
  table: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11M6 6.5v6'],
  view: ['M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z', 'M8 8m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0'],
  collection: ['M8 3c3 0 5 .9 5 2s-2 2-5 2-5-.9-5-2 2-2 5-2z', 'M3 5v6c0 1.1 2 2 5 2s5-.9 5-2V5'],
  external: ['M3 3.5h4.5M3 3.5v9h9V8', 'M9 3.5h3.5V7', 'M12 4l-5 5'],
  join: ['M6 8m-3.2 0a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0', 'M10 8m-3.2 0a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0'],
};

/** Kind icon sized to `size`, as an SVG group positioned at (x,y). */
export function kindIcon(glyph: KindGlyph, x: number, y: number, size = 14): SVGGElement {
  const g = svg('g', { transform: `translate(${x} ${y}) scale(${size / 16})`, 'aria-hidden': 'true' });
  for (const d of KIND_PATHS[glyph]) {
    g.appendChild(
      svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    );
  }
  return g;
}
