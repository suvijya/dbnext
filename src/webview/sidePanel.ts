/**
 * The side panel: details for the selected entity, or a workspace overview when nothing is selected.
 * All model text is inserted via textContent.
 */

import type { Entity, Provenance, Relation, SchemaModel, SourceRef } from '../core/model';
import { ENGINES, SOURCE_LABELS } from '../core/model';
import { columnNote, emptyNotes, tableNote, withColumnNote, withTableNote, type Notes } from '../core/notes';
import {
  columnKeys,
  columnType,
  DERIVATION_LABELS,
  isUncertain,
  provenanceSummary,
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
  /** The user edited a note; 
otes is the complete new set. */
  onNotesChange(notes: Notes): void;
  onClose(): void;
}

export class SidePanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private model: SchemaModel | null = null;
  private notes: Notes = emptyNotes();
  /** Columns whose note editor is open (entityId\0column). */
  private readonly editing = new Set<string>();

  constructor(private readonly cb: SidePanelCallbacks) {
    this.el = el('aside', { class: 'side-panel', attrs: { 'aria-label': 'Details', role: 'region' } });
    this.titleEl = el('h2', { class: 'side-title', text: 'Overview' });
    const closeBtn = button({ class: 'side-close', icon: uiIcon('close'), title: 'Hide panel', attrs: { 'aria-label': 'Hide details panel' }, on: { click: () => this.cb.onClose() } });
    const header = el('div', { class: 'side-header' }, [this.titleEl, closeBtn]);
    this.body = el('div', { class: 'side-body' });
    this.el.append(header, this.body);
  }

  setNotes(notes: Notes): void {
    this.notes = notes;
  }

  /** True while the user is typing in a note field (the host defers re-rendering then). */
  isEditing(): boolean {
    const a = document.activeElement;
    return !!a && a.tagName === 'TEXTAREA' && this.el.contains(a);
  }

  private commit(notes: Notes): void {
    this.notes = notes;
    this.cb.onNotesChange(notes);
  }

  private noteField(value: string, placeholder: string, label: string, cls: string, onSave: (text: string) => void): HTMLElement {
    const ta = el('textarea', { class: cls, attrs: { rows: 3, placeholder, maxlength: 2000, 'aria-label': label } });
    ta.value = value;
    ta.addEventListener('change', () => onSave(ta.value));
    return ta;
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
      ...(isUncertain(e.provenance) ? [uncertainBadge(e.provenance!)] : []),
    ]);
    body.appendChild(kindRow);

    if (e.modelNames.length) body.appendChild(metaLine('Model', e.modelNames.join(', ')));
    if (e.comment) body.appendChild(el('p', { class: 'side-comment', text: e.comment }));
    body.appendChild(sectionTitle('Notes'));
    body.appendChild(el('p', { class: 'side-note-hint', text: 'Saved to .dbnext/notes.json and included in exports.' }));
    body.appendChild(this.noteField(tableNote(this.notes, e.id) ?? '', 'Add a note about this table…', `Note for ${qualifiedName(e)}`, 'side-note', (v) => this.commit(withTableNote(this.notes, e.id, v))));

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
          el('td', { class: 'mono' }, [el('span', { text: c.name }), ...(this.noteToggle(e, c.name))]),
          typeCell,
          el('td', { class: 'center', text: c.nullable && !c.primaryKey ? '✓' : '' }),
          el('td', {}, columnKeys(c).map((k) => el('span', { class: `kbadge k-${k.toLowerCase()}`, text: k }))),
          refCell,
        ]);
        if (c.default !== undefined) row.title = `default: ${c.default}`;
        if (isUncertain(c.provenance)) {
          row.classList.add('is-uncertain');
          row.title = [row.title, provenanceSummary(c.provenance!)].filter(Boolean).join(' · ');
        }
        tbody.appendChild(row);
        const cNote = columnNote(this.notes, e.id, c.name);
        const open = this.editing.has(`\0${c.name}`);
        if (c.comment || cNote || open) {
          const cell = el('td', { attrs: { colspan: 5 } });
          if (c.comment) cell.appendChild(el('p', { class: 'col-comment', text: c.comment }));
          if (open) cell.appendChild(this.noteField(cNote ?? '', 'Add a note about this column…', `Note for column ${c.name}`, 'side-note col-note', (v) => this.commit(withColumnNote(this.notes, e.id, c.name, v))));
          else if (cNote) cell.appendChild(el('p', { class: 'col-comment', text: `Note: ${cNote}` }));
          tbody.appendChild(el('tr', { class: 'col-note-row' }, [cell]));
        }
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
    const relGroup = (title: string, items: { text: string; target: string; prov?: Provenance }[]): void => {
      if (!items.length) return;
      body.appendChild(sectionTitle(title));
      const ul = el('ul', { class: 'side-list rel-list' });
      for (const it of items) {
        ul.appendChild(el('li', { class: isUncertain(it.prov) ? 'is-uncertain' : '' }, [button({ class: 'link-inline', label: it.text, title: `Jump to ${this.nameOf(it.target)}`, on: { click: () => this.cb.onJump(it.target) } })]));
      }
      body.appendChild(ul);
    };
    relGroup('References', refOut.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.to, prov: r.provenance })));
    relGroup('Referenced by', refIn.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.from, prov: r.provenance })));
    relGroup('Many-to-many', m2m.map((r) => ({ text: describeRelation(r, e.id, (id) => this.nameOf(id)), target: r.from === e.id ? r.to : r.from, prov: r.provenance })));
    this.renderWhy(e, [...refOut, ...refIn, ...m2m]);
  }

  /** The small "edit note" button next to a column name. */
  private noteToggle(e: Entity, column: string): HTMLElement[] {
    const key = `${e.id}\0${column}`;
    const open = this.editing.has(key);
    const btn = button({
      class: `link-inline note-toggle${open ? ' is-open' : ''}`,
      label: columnNote(this.notes, e.id, column) ? '✎' : '+',
      title: open ? 'Hide note editor' : 'Add or edit a note for this column',
      attrs: { 'aria-label': `Note for column ${column}`, 'aria-expanded': open },
      on: {
        click: () => {
          if (open) this.editing.delete(key);
          else this.editing.add(key);
          this.render(e.id);
        },
      },
    });
    return [btn];
  }

  /** "Why is this here?": how the entity, its implied columns and its relations were derived, with source links. */
  private renderWhy(e: Entity, rels: Relation[]): void {
    const items: { label: string; prov: Provenance }[] = [];
    if (e.provenance) items.push({ label: 'This table', prov: e.provenance });
    for (const c of e.columns) if (c.provenance) items.push({ label: `Column ${c.name}`, prov: c.provenance });
    for (const r of rels.slice(0, 20)) if (r.provenance) items.push({ label: describeRelation(r, e.id, (id) => this.nameOf(id)), prov: r.provenance });
    if (!items.length) return;
    this.body.appendChild(sectionTitle('Why is this here?'));
    for (const it of items) this.body.appendChild(this.provenanceBlock(it.label, it.prov));
  }

  private provenanceBlock(label: string, p: Provenance): HTMLElement {
    const box = el('div', { class: `prov${isUncertain(p) ? ' is-uncertain' : ''}` });
    box.appendChild(el('div', { class: 'prov-head' }, [el('span', { class: 'prov-label', text: label }), el('span', { class: `badge badge-conf conf-${p.confidence}`, text: provenanceSummary(p) })]));
    if (p.notes.length) {
      const ul = el('ul', { class: 'side-list prov-notes' });
      for (const n of p.notes) ul.appendChild(el('li', { text: n }));
      box.appendChild(ul);
    }
    if (p.refs.length) {
      const row = el('div', { class: 'prov-refs' });
      for (const ref of p.refs) {
        row.appendChild(button({ class: 'link-btn', icon: uiIcon('goto'), label: `${ref.file}:${ref.line + 1}`, title: 'Open source', on: { click: () => this.cb.onOpenRef(ref) } }));
      }
      box.appendChild(row);
    }
    return box;
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

function uncertainBadge(p: Provenance): HTMLElement {
  const b = el('span', { class: 'badge badge-uncertain', text: DERIVATION_LABELS[p.derivation] ?? p.derivation });
  b.title = provenanceSummary(p);
  return b;
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
