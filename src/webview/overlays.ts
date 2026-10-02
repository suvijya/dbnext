/**
 * Full-area state overlays (scanning / empty / error) and a small busy chip shown while rescanning
 * with the previous diagram still visible. Also owns the aria-live status region.
 */

import type { MapStatus } from '../core/protocol';
import { SOURCE_LABELS, type SourceKind } from '../core/model';
import { button, el } from './dom';
import { uiIcon } from './icons';

export interface OverlayCallbacks {
  onRescan(): void;
  onShowLog(): void;
}

const SUPPORTED: SourceKind[] = [
  'sql', 'dbml', 'prisma', 'typeorm', 'mikroorm', 'drizzle', 'sequelize', 'mongoose', 'knex', 'kysely',
  'django', 'sqlalchemy', 'sqlmodel', 'peewee', 'tortoise', 'rails', 'laravel', 'doctrine', 'gorm',
  'ent', 'bun', 'jpa', 'exposed', 'liquibase', 'efcore', 'ecto', 'seaorm', 'diesel',
];

export class Overlays {
  readonly el: HTMLElement;
  readonly busyChip: HTMLElement;
  readonly liveRegion: HTMLElement;

  constructor(private readonly cb: OverlayCallbacks) {
    this.el = el('div', { class: 'overlay', attrs: { role: 'status' } });
    this.el.hidden = true;
    this.busyChip = el('div', { class: 'busy-chip' });
    this.busyChip.hidden = true;
    this.liveRegion = el('div', { class: 'sr-only', attrs: { 'aria-live': 'polite', role: 'status' } });
  }

  /** Shows / hides the small busy chip (rescanning, layout progress) with custom text. */
  setBusy(text: string | null): void {
    while (this.busyChip.firstChild) this.busyChip.removeChild(this.busyChip.firstChild);
    if (text === null) {
      this.busyChip.hidden = true;
      return;
    }
    this.busyChip.append(el('span', { class: 'spinner spinner-sm' }), el('span', { text }));
    this.busyChip.hidden = false;
  }

  update(status: MapStatus, message: string | undefined, hasModel: boolean): void {
    this.announce(status, message);
    if (status === 'ready') {
      this.el.hidden = true;
      this.setBusy(null);
      return;
    }
    if (status === 'scanning') {
      if (hasModel) {
        this.el.hidden = true;
        this.setBusy('Rescanning…');
      } else {
        this.setBusy(null);
        this.showPanel(this.scanningPanel(message));
      }
      return;
    }
    this.setBusy(null);
    this.showPanel(status === 'empty' ? this.emptyPanel() : this.errorPanel(message));
  }

  private announce(status: MapStatus, message: string | undefined): void {
    const text =
      message ??
      (status === 'scanning' ? 'Mapping your databases' : status === 'empty' ? 'No database schema detected' : status === 'error' ? 'Scan failed' : 'Ready');
    this.liveRegion.textContent = text;
  }

  private showPanel(panel: HTMLElement): void {
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.el.appendChild(panel);
    this.el.hidden = false;
  }

  private scanningPanel(message: string | undefined): HTMLElement {
    return el('div', { class: 'overlay-card' }, [
      el('div', { class: 'spinner' }),
      el('h2', { class: 'overlay-title', text: 'Mapping your databases…' }),
      el('p', { class: 'overlay-text', text: message ?? 'Scanning the workspace for schema definitions.' }),
    ]);
  }

  private emptyPanel(): HTMLElement {
    const chips = el('div', { class: 'tech-chips' });
    for (const s of SUPPORTED) chips.appendChild(el('span', { class: 'tech-chip', text: SOURCE_LABELS[s] ?? s }));
    return el('div', { class: 'overlay-card' }, [
      el('div', { class: 'overlay-glyph', attrs: { 'aria-hidden': 'true' } }, [uiIcon('fit')]),
      el('h2', { class: 'overlay-title', text: 'No database schema found' }),
      el('p', { class: 'overlay-text', text: 'DBNext scans your workspace for schema definitions and ORM models. Open a project that defines a database and it will appear here automatically.' }),
      el('p', { class: 'overlay-subtle', text: 'Understood technologies:' }),
      chips,
      el('div', { class: 'overlay-actions' }, [
        button({ class: 'btn btn-primary', icon: uiIcon('refresh'), label: 'Rescan workspace', on: { click: () => this.cb.onRescan() } }),
        button({ class: 'btn', icon: uiIcon('log'), label: 'Show log', on: { click: () => this.cb.onShowLog() } }),
      ]),
    ]);
  }

  private errorPanel(message: string | undefined): HTMLElement {
    return el('div', { class: 'overlay-card' }, [
      el('div', { class: 'overlay-glyph error', attrs: { 'aria-hidden': 'true' } }, [uiIcon('warning')]),
      el('h2', { class: 'overlay-title', text: 'The scan failed' }),
      el('p', { class: 'overlay-text', text: message ?? 'Something went wrong while scanning the workspace.' }),
      el('div', { class: 'overlay-actions' }, [
        button({ class: 'btn', icon: uiIcon('log'), label: 'Show log', on: { click: () => this.cb.onShowLog() } }),
        button({ class: 'btn btn-primary', icon: uiIcon('refresh'), label: 'Rescan workspace', on: { click: () => this.cb.onRescan() } }),
      ]),
    ]);
  }
}
