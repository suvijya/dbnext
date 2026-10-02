/**
 * The side panel: details for the selected entity, or a workspace overview when nothing is selected.
 * All model text is inserted via textContent.
 */

import type { Entity, SchemaModel, SourceRef } from '../core/model';
import { ENGINES, SOURCE_LABELS } from '../core/model';
import {
  columnKeys,
  columnType,
  describeRelation,
  entityKindLabel,
  enumSummary,
  qualifiedName,
  relationsByEntity,
  summaryText,
} from '../core/format';
import { button, el } from './dom';
import { uiIcon } from './icons';
import { degrees } from './graphModel';

export interface SidePanelCallbacks {
  onJump(entityId: string): void;
  onOpenRef(ref: SourceRef): void;
  onShowLog(): void;
  onClose(): void;
}

export class SidePanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private model: SchemaModel | null = null;

  constructor(private readonly cb: SidePanelCallbacks) {
    this.el = el('aside', { class: 'side-panel', attrs: { 'aria-label': 'Details', role: 'region' } });
    this.titleEl = el('h2', { class: 'side-title', text: 'Overview' });
    const closeBtn = button({ class: 'side-close', icon: uiIcon('close'), title: 'Hide panel', attrs: { 'aria-label': 'Hide details panel' }, on: { click: () => this.cb.onClose() } });
    const header = el('div', { class: 'side-header' }, [this.titleEl, closeBtn]);
    this.body = el('div', { class: 'side-body' });
    this.el.append(header, this.body);
  }

  setModel(model: SchemaModel | null): void {
    this.model = model;
  }

  render(selection: string | null): void {
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    if (!this.model) {
      this.titleEl.textContent = 'DB Map';
      this.body.appendChild(el('p', { class: 'side-empty', text: 'No schema loaded yet.' }));
      return;
    }
    const entity = selection ? this.model.entities.find((e) => e.id === selection) : undefined;
    if (entity) this.renderEntity(entity);
    else this.renderOverview();
  }

  // ── Entity details ─────────────────────────────────────────────────────────────────────────────

  private nameOf(id: string): string {
    const e = this.model?.entities.find((x) => x.id === id);
    if (e) return qualifiedName(e);
    const en = this.model?.enums.find((x) => x.id === id);
    return en ? (en.schema ? `${en.schema}.${en.name}` : en.name) : id;
  }

  private renderEntity(e: Entity): void {
    this.titleEl.textContent = qualifiedName(e);
    const body = this.body;

    const kindRow = el('div', { class: 'meta-badges' }, [
      el('span', { class: `badge badge-kind kind-${e.kind}`, text: entityKindLabel(e) }),
      ...(e.schema ? [el('span', { class: 'badge badge-schema', text: e.schema })] : []),
      ...e.sources.map((s) => el('span', { class: 'badge badge-source', text: SOURCE_LABELS[s] ?? s })),
      ...(e.engine ? [el('span', { class: 'badge badge-engine', text: ENGINES[e.engine]?.label ?? e.engine })] : []),
    ]);
    body.appendChild(kindRow);

    if (e.modelNames.length) body.appendChild(metaLine('Model', e.modelNames.join(', ')));
    if (e.comment) body.appendChild(el('p', { class: 'side-comment', text: e.comment }));

    if (e.source) {
      const link = button({
        class: 'link-btn',
        icon: uiIcon('goto'),
        label: `${e.source.file}:${e.source.line + 1}`,
        title: 'Go to definition',
        on: { click: () => e.source && this.cb.onOpenRef(e.source) },
      });
      body.appendChild(el('div', { class: 'side-filelink' }, [link]));
    }

    // Columns
    if (e.columns.length) {
      body.appendChild(sectionTitle(`Columns (${e.columns.length})`));
      const table = el('table', { class: 'col-table' });
      const thead = el('thead', {}, [
        el('tr', {}, [th('Column'), th('Type'), th('Null'), th('Key'), th('References')]),
      ]);
      const tbody = el('tbody');
      const enumById = new Map(this.model!.enums.map((en) => [en.id, en]));
      for (const c of e.columns) {
        const typeCell = el('td', { class: 'mono' }, [el('span', { text: columnType(c) || '—' })]);
        if (c.enumRef) {
          const en = enumById.get(c.enumRef);
          if (en) typeCell.title = `enum ${en.name}: ${enumSummary(en, 20)}`;
          typeCell.classList.add('is-enum');
        }
        const refCell = el('td', {});
        if (c.references) {
          const refName = `${this.nameOf(c.references.entity)}${c.references.column ? `.${c.references.column}` : ''}`;
          refCell.appendChild(button({ class: 'link-inline', label: refName, title: `Jump to ${this.nameOf(c.references.entity)}`, on: { click: () => this.cb.onJump(c.references!.entity) } }));
          if (c.references.inferred) refCell.appendChild(el('span', { class: 'muted', text: ' (inferred)' }));
        }
        const row = el('tr', {}, [
          el('td', { class: 'mono', text: c.name }),
          typeCell,
          el('td', { class: 'center', text: c.nullable && !c.primaryKey ? '✓' : '' }),
          el('td', {}, columnKeys(c).map((k) => el('span', { class: `kbadge k-${k.toLowerCase()}`, text: k }))),
          refCell,
        ]);
        if (c.default !== undefined) row.title = `default: ${c.default}`;
        tbody.appendChild(row);
      }
      table.append(thead, tbody);
      body.appendChild(table);
    }

    // Indexes
    if (e.indexes.length) {
      body.appendChild(sectionTitle(`Indexes (${e.indexes.length})`));
      const ul = el('ul', { class: 'side-list' });
      for (const ix of e.indexes) {
        ul.appendChild(el('li', {}, [
          ix.name ? el('span', { class: 'mono', text: ix.name }) : el('span', { class: 'muted', text: '(unnamed)' }),
          el('span', { text: ` (${ix.columns.join(', ')})${ix.unique ? ' · unique' : ''}` }),
        ]));
      }
      body.appendChild(ul);
    }

    // Relations
    const rels = relationsByEntity(this.model!.relations).get(e.id);
    const refOut = (rels?.outgoing ?? []).filter((r) => r.cardinality !== 'many-to-many');
    const refIn = rels?.incoming ?? [];
    const m2m = (rels?.outgoing ?? []).filter((r) => r.cardinality === 'many-to-many');
    const relGroup = (title: string, items: { text: string; target: string }[]): void => {
      if (!items.length) return;
      body.appendChild(sectionTitle(title));
      const ul = el('ul', { class: 'side-list rel-list' });
      for (const it of items) {
        ul.appendChild(el('li', {}, [button({ class: 'link-inline', label: it.text, title: `Jump to ${this.nameOf(it.target)}`, on: { click: () => this.cb.onJump(it.target) } })]));
      }
      body.appendChild(ul);
    };
    relGroup('References', refOut.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.to })));
    relGroup('Referenced by', refIn.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.from })));
    relGroup('Many-to-many', m2m.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.from === e.id ? r.to : r.from })));
  }

  // ── Overview ───────────────────────────────────────────────────────────────────────────────────

  private renderOverview(): void {
    this.titleEl.textContent = 'Overview';
    const body = this.body;
    const model = this.model!;

    body.appendChild(el('p', { class: 'side-summary', text: summaryText(model) }));
    if (model.workspaceName) body.appendChild(el('p', { class: 'muted', text: model.workspaceName }));

    if (model.engines.length) {
      body.appendChild(sectionTitle('Databases'));
      const ul = el('ul', { class: 'side-list' });
      for (const eng of model.engines) {
        ul.appendChild(el('li', {}, [
          el('span', { class: 'badge badge-engine', text: eng.label }),
          el('span', { class: 'muted', text: ` ${eng.category} · ${eng.evidence.length} ${eng.evidence.length === 1 ? 'clue' : 'clues'}` }),
        ]));
      }
      body.appendChild(ul);
    }

    if (model.sources.length) {
      body.appendChild(sectionTitle('Detected from'));
      const ul = el('ul', { class: 'side-list' });
      for (const s of model.sources) {
        ul.appendChild(el('li', { text: `${s.label} — ${s.files} ${s.files === 1 ? 'file' : 'files'}, ${s.entities} ${s.entities === 1 ? 'table' : 'tables'}` }));
      }
      body.appendChild(ul);
    }

    // Largest tables
    const defined = model.entities.filter((e) => !e.external);
    const largest = [...defined].sort((a, b) => b.columns.length - a.columns.length).slice(0, 5);
    if (largest.length) {
      body.appendChild(sectionTitle('Largest tables'));
      body.appendChild(this.entityList(largest.map((e) => ({ e, note: `${e.columns.length} cols` }))));
    }

    // Most connected
    const deg = degrees(model);
    const connected = [...defined]
      .map((e) => ({ e, n: deg.get(e.id) ?? 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 5);
    if (connected.length) {
      body.appendChild(sectionTitle('Most connected'));
      body.appendChild(this.entityList(connected.map((x) => ({ e: x.e, note: `${x.n} ${x.n === 1 ? 'link' : 'links'}` }))));
    }

    if (model.enums.length) {
      body.appendChild(sectionTitle(`Enums (${model.enums.length})`));
      const ul = el('ul', { class: 'side-list' });
      for (const en of model.enums.slice(0, 12)) {
        const li = el('li', {}, [el('span', { class: 'mono', text: en.name }), el('span', { class: 'muted', text: `: ${enumSummary(en, 8)}` })]);
        li.title = en.values.join(', ');
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    // Warnings
    body.appendChild(sectionTitle('Diagnostics'));
    const warnRow = el('div', { class: 'warn-row' }, [
      el('span', { class: model.warnings.length ? 'warn-count has' : 'warn-count', text: `${model.warnings.length} ${model.warnings.length === 1 ? 'warning' : 'warnings'}` }),
      button({ class: 'link-btn', icon: uiIcon('log'), label: 'Show log', on: { click: () => this.cb.onShowLog() } }),
    ]);
    body.appendChild(warnRow);
  }

  private entityList(items: { e: Entity; note: string }[]): HTMLElement {
    const ul = el('ul', { class: 'side-list entity-list' });
    for (const { e, note } of items) {
      ul.appendChild(el('li', {}, [
        button({ class: 'link-inline', label: qualifiedName(e), on: { click: () => this.cb.onJump(e.id) } }),
        el('span', { class: 'muted', text: ` ${note}` }),
      ]));
    }
    return ul;
  }
}

function sectionTitle(text: string): HTMLElement {
  return el('h3', { class: 'side-section', text });
}

function metaLine(label: string, value: string): HTMLElement {
  return el('div', { class: 'meta-line' }, [el('span', { class: 'meta-label', text: `${label}: ` }), el('span', { text: value })]);
}

function th(text: string): HTMLElement {
  return el('th', { text, attrs: { scope: 'col' } });
}
