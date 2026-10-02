/**
 * Bottom-right minimap: a scaled overview of all node rectangles plus the current viewport, with
 * click / drag to navigate.
 */

import { svg } from './dom';
import type { Rect } from './geometry';

export interface MinimapRect extends Rect {
  selected?: boolean;
}

const W = 190;
const H = 130;
const PAD = 6;

export class Minimap {
  readonly el: HTMLElement;
  private readonly root: SVGSVGElement;
  private readonly nodesLayer: SVGGElement;
  private readonly viewRect: SVGRectElement;
  private bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dragging = false;

  constructor(private readonly onCenter: (worldX: number, worldY: number) => void) {
    this.root = svg('svg', { class: 'minimap-svg', viewBox: `0 0 ${W} ${H}`, width: String(W), height: String(H) });
    this.nodesLayer = svg('g', { class: 'minimap-nodes' });
    this.viewRect = svg('rect', { class: 'minimap-view', x: '0', y: '0', width: '0', height: '0' });
    this.root.append(this.nodesLayer, this.viewRect);
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.appendChild(this.root);

    this.root.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.root.setPointerCapture(e.pointerId);
      this.navigate(e);
    });
    this.root.addEventListener('pointermove', (e) => {
      if (this.dragging) this.navigate(e);
    });
    this.root.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try {
        this.root.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
  }

  private navigate(e: PointerEvent): void {
    const rect = this.root.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    if (this.scale <= 0) return;
    const worldX = (mx - this.offsetX) / this.scale + this.bounds.x;
    const worldY = (my - this.offsetY) / this.scale + this.bounds.y;
    this.onCenter(worldX, worldY);
  }

  setNodes(rects: readonly MinimapRect[], bounds: Rect | null): void {
    while (this.nodesLayer.firstChild) this.nodesLayer.removeChild(this.nodesLayer.firstChild);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.bounds = { x: 0, y: 0, width: 1, height: 1 };
      this.scale = 1;
      return;
    }
    this.bounds = bounds;
    this.scale = Math.min((W - PAD * 2) / bounds.width, (H - PAD * 2) / bounds.height);
    this.offsetX = PAD + (W - PAD * 2 - bounds.width * this.scale) / 2;
    this.offsetY = PAD + (H - PAD * 2 - bounds.height * this.scale) / 2;
    for (const r of rects) {
      this.nodesLayer.appendChild(
        svg('rect', {
          class: `minimap-node${r.selected ? ' selected' : ''}`,
          x: this.offsetX + (r.x - bounds.x) * this.scale,
          y: this.offsetY + (r.y - bounds.y) * this.scale,
          width: Math.max(1, r.width * this.scale),
          height: Math.max(1, r.height * this.scale),
        }),
      );
    }
  }

  setViewport(view: Rect): void {
    this.viewRect.setAttribute('x', String(this.offsetX + (view.x - this.bounds.x) * this.scale));
    this.viewRect.setAttribute('y', String(this.offsetY + (view.y - this.bounds.y) * this.scale));
    this.viewRect.setAttribute('width', String(Math.max(0, view.width * this.scale)));
    this.viewRect.setAttribute('height', String(Math.max(0, view.height * this.scale)));
  }

  setVisible(visible: boolean): void {
    this.el.style.display = visible ? '' : 'none';
  }
}
