/**
 * Schema diff view: a full-panel overlay with a summary list and colour-coded table cards.
 * All text goes through textContent (see dom.ts); nothing from the model is ever parsed as HTML.
 */

import type { ChangeKind, ColumnChange, EntityChange, SchemaDiff } from '../core/diff';
import { diffSummaryText, isEmptyDiff } from '../core/diff';
import { button, clear, el } from './dom';

export interface DiffViewHandlers {
  onCopyMarkdown(): void;
  onClose(): void;
}

const MARK: Record<ChangeKind, string> = { added: '+', removed: '\u2212', changed: '~' };

export class DiffView {
  readonly el: HTMLElement;
  private readonly title = el('h2', { class: 'diff-title' });
  private readonly summary = el('div', { class: 'diff-summary-line' });
  private readonly list = el('nav', { class: 'diff-list', attrs: { 'aria-label': 'Changes' } });
  private readonly cards = el('div', { class: 'diff-cards' });

  constructor(handlers: DiffViewHandlers) {
    const header = el('div', { class: 'diff-header' }, [
      el('div', { class: 'diff-heading' }, [this.title, this.summary]),
      button({ class: 'diff-btn', label: 'Copy as Markdown', on: { click: () => handlers.onCopyMarkdown() } }),
      button({ class: 'diff-btn', label: 'Back to map', on: { click: () => handlers.onClose() } }),
    ]);
    const body = el('div', { class: 'diff-body' }, [this.list, this.cards]);
    this.el = el('section', { class: 'diff-view', attrs: { role: 'region', 'aria-label': 'Schema diff' } }, [header, body]);
    this.el.hidden = true;
    this.el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') handlers.onClose();
    });
  }

  hide(): void {
    this.el.hidden = true;
  }

  show(diff: SchemaDiff, base: string, head: string): void {
    this.el.hidden = false;
    this.title.textContent = `Schema diff: ${base} \u2192 ${head}`;
    this.summary.textContent = diffSummaryText(diff);
    clear(this.list);
    clear(this.cards);

    if (isEmptyDiff(diff)) {
      this.cards.appendChild(el('p', { class: 'diff-empty', text: 'No schema changes between these two versions.' }));
      return;
    }

    const s = diff.summary;
    this.list.appendChild(
      el('div', { class: 'diff-legend' }, (['added', 'changed', 'removed'] as const).map((k) =>
        el('span', { class: `diff-chip ${k}`, text: `${MARK[k]} ${s.entities[k] + s.relations[k] + s.enums[k] + s.columns[k]} ${k}` }),
      )),
    );

    const section = (title: string, items: HTMLElement[]) => {
      if (!items.length) return;
      this.list.appendChild(el('h3', { class: 'diff-list-title', text: title }));
      const ul = el('ul', { class: 'diff-items' });
      for (const li of items) ul.appendChild(li);
      this.list.appendChild(ul);
    };

    section('Tables', diff.entities.map((e) => {
      const n = e.columns.length;
      const detail = e.kind === 'changed' ? ` (${n} column${n === 1 ? '' : 's'})` : '';
      const li = el('li', { class: `diff-item ${e.kind}` }, [el('span', { class: 'diff-mark', text: MARK[e.kind] }), `${e.name}${detail}`]);
      return li;
    }));
    section('Relations', diff.relations.map((r) =>
      el('li', { class: `diff-item ${r.kind}`, title: r.changes.join('; ') || undefined }, [el('span', { class: 'diff-mark', text: MARK[r.kind] }), r.label]),
    ));
    section('Enums', diff.enums.map((e) =>
      el('li', { class: `diff-item ${e.kind}` }, [el('span', { class: 'diff-mark', text: MARK[e.kind] }), e.name]),
    ));

    for (const e of diff.entities) this.cards.appendChild(this.entityCard(e));

    if (diff.relations.length) {
      this.cards.appendChild(
        el('div', { class: 'diff-card neutral' }, [
          el('div', { class: 'diff-card-head' }, [el('span', { class: 'diff-card-name', text: 'Relations' })]),
          ...diff.relations.map((r) =>
            el('div', { class: `diff-col ${r.kind}` }, [
              el('span', { class: 'diff-mark', text: MARK[r.kind] }),
              el('span', { class: 'diff-col-name', text: r.label }),
              el('span', { class: 'diff-col-detail', text: r.changes.length ? r.changes.join('; ') : r.cardinality }),
            ]),
          ),
        ]),
      );
    }
    if (diff.enums.length) {
      this.cards.appendChild(
        el('div', { class: 'diff-card neutral' }, [
          el('div', { class: 'diff-card-head' }, [el('span', { class: 'diff-card-name', text: 'Enums' })]),
          ...diff.enums.map((e) =>
            el('div', { class: `diff-col ${e.kind}` }, [
              el('span', { class: 'diff-mark', text: MARK[e.kind] }),
              el('span', { class: 'diff-col-name', text: e.name }),
              el('span', {
                class: 'diff-col-detail',
                text: [e.valuesAdded.length ? `+ ${e.valuesAdded.join(', ')}` : '', e.valuesRemoved.length ? `\u2212 ${e.valuesRemoved.join(', ')}` : ''].filter(Boolean).join('  '),
              }),
            ]),
          ),
        ]),
      );
    }
  }

  private entityCard(e: EntityChange): HTMLElement {
    const rows = e.columns.map((c) => this.columnRow(c));
    for (const i of e.indexesAdded) rows.push(this.noteRow('added', `index ${i}`));
    for (const i of e.indexesRemoved) rows.push(this.noteRow('removed', `index ${i}`));
    if (e.unchangedColumns) rows.push(el('div', { class: 'diff-col unchanged', text: `${e.unchangedColumns} unchanged column${e.unchangedColumns === 1 ? '' : 's'}` }));
    return el('article', { class: `diff-card ${e.kind}` }, [
      el('div', { class: 'diff-card-head' }, [
        el('span', { class: 'diff-mark', text: MARK[e.kind] }),
        el('span', { class: 'diff-card-name', text: e.name }),
        el('span', { class: 'diff-card-kind', text: e.kindChange ?? e.entityKind }),
      ]),
      ...rows,
    ]);
  }

  private noteRow(kind: ChangeKind, text: string): HTMLElement {
    return el('div', { class: `diff-col ${kind}` }, [el('span', { class: 'diff-mark', text: MARK[kind] }), el('span', { class: 'diff-col-name', text })]);
  }

  private columnRow(c: ColumnChange): HTMLElement {
    const col = c.after ?? c.before;
    const detail = c.kind === 'changed' ? c.changes.join('; ') : (col?.type ?? '');
    return el('div', { class: `diff-col ${c.kind}` }, [
      el('span', { class: 'diff-mark', text: MARK[c.kind] }),
      el('span', { class: 'diff-col-name', text: c.name }),
      el('span', { class: 'diff-col-detail', text: detail }),
    ]);
  }
}
