/**
 * The top toolbar: search, fit, zoom, direction, column mode, filters popover, re-layout, export
 * menu, rescan and the side-panel toggle. All controls are real <button>/<input>/<select> with
 * aria-labels so the toolbar is fully keyboard reachable.
 */

import { button, el } from './dom';
import { uiIcon } from './icons';
import type { ColumnMode, Direction, Filters } from './types';

export interface FilterOption {
  value: string;
  label: string;
}

export interface ToolbarOptions {
  columnMode: ColumnMode;
  direction: Direction;
  filters: Filters;
}

export interface ToolbarCallbacks {
  onSearch(query: string): void;
  onSearchCycle(dir: 1 | -1): void;
  onFit(): void;
  onZoom(kind: 'in' | 'out' | 'reset'): void;
  onDirection(dir: Direction): void;
  onColumnMode(mode: ColumnMode): void;
  onFiltersChange(filters: Filters): void;
  onRelayout(): void;
  onExport(kind: 'markdown' | 'mermaid' | 'svg'): void;
  onRescan(): void;
  onTogglePanel(): void;
}

export class Toolbar {
  readonly el: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCounter: HTMLElement;
  private readonly zoomLabel: HTMLButtonElement;
  private readonly directionBtn: HTMLButtonElement;
  private readonly columnSelect: HTMLSelectElement;
  private readonly filtersBtn: HTMLButtonElement;
  private readonly filtersPopover: HTMLElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly exportPopover: HTMLElement;

  private filters: Filters;
  private direction: Direction;
  private schemas: FilterOption[] = [];
  private sources: FilterOption[] = [];
  private engines: FilterOption[] = [];

  constructor(opts: ToolbarOptions, private readonly cb: ToolbarCallbacks) {
    this.filters = opts.filters;
    this.direction = opts.direction;
    this.el = el('header', { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': 'Diagram controls' } });

    // Search
    const searchWrap = el('div', { class: 'tb-group tb-search' });
    this.searchInput = el('input', {
      class: 'tb-input',
      type: 'search',
      attrs: { placeholder: 'Search tables & columns', 'aria-label': 'Search tables and columns', spellcheck: 'false' },
    });
    this.searchInput.addEventListener('input', () => this.cb.onSearch(this.searchInput.value));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.cb.onSearchCycle(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && this.searchInput.value) {
        e.preventDefault();
        this.searchInput.value = '';
        this.cb.onSearch('');
      }
    });
    this.searchCounter = el('span', { class: 'tb-search-count', attrs: { 'aria-live': 'polite' } });
    searchWrap.append(iconSpan('search'), this.searchInput, this.searchCounter);

    // View controls
    const view = el('div', { class: 'tb-group' });
    const fitBtn = button({ class: 'tb-btn', icon: uiIcon('fit'), title: 'Fit to view (0)', attrs: { 'aria-label': 'Fit to view' }, on: { click: () => this.cb.onFit() } });
    const zoomOut = button({ class: 'tb-btn', icon: uiIcon('minus'), title: 'Zoom out (-)', attrs: { 'aria-label': 'Zoom out' }, on: { click: () => this.cb.onZoom('out') } });
    this.zoomLabel = button({ class: 'tb-btn tb-zoom', label: '100%', title: 'Reset zoom to 100%', attrs: { 'aria-label': 'Reset zoom' }, on: { click: () => this.cb.onZoom('reset') } });
    const zoomIn = button({ class: 'tb-btn', icon: uiIcon('plus'), title: 'Zoom in (+)', attrs: { 'aria-label': 'Zoom in' }, on: { click: () => this.cb.onZoom('in') } });
    view.append(fitBtn, zoomOut, this.zoomLabel, zoomIn);

    // Direction + columns
    const layoutGroup = el('div', { class: 'tb-group' });
    this.directionBtn = button({
      class: 'tb-btn tb-text',
      label: this.directionLabel(),
      title: 'Toggle layout direction',
      attrs: { 'aria-label': 'Toggle layout direction' },
      icon: uiIcon('direction'),
      on: { click: () => this.cb.onDirection(this.direction === 'LR' ? 'TB' : 'LR') },
    });
    this.columnSelect = el('select', { class: 'tb-select', attrs: { 'aria-label': 'Column display mode' } });
    for (const [value, text] of [['all', 'All columns'], ['keys', 'Keys only'], ['none', 'Header only']] as const) {
      const o = el('option', { text, attrs: { value } });
      if (value === opts.columnMode) o.selected = true;
      this.columnSelect.appendChild(o);
    }
    this.columnSelect.addEventListener('change', () => this.cb.onColumnMode(this.columnSelect.value as ColumnMode));
    const colWrap = el('label', { class: 'tb-select-wrap' }, [iconSpan('columns'), this.columnSelect]);
    layoutGroup.append(this.directionBtn, colWrap);

    // Filters
    const filterGroup = el('div', { class: 'tb-group tb-popover-host' });
    this.filtersBtn = button({ class: 'tb-btn tb-text', label: 'Filters', icon: uiIcon('filter'), title: 'Filters', attrs: { 'aria-haspopup': 'true', 'aria-expanded': 'false' }, on: { click: () => this.togglePopover('filters') } });
    this.filtersPopover = el('div', { class: 'tb-popover', attrs: { role: 'dialog', 'aria-label': 'Filters' } });
    this.filtersPopover.hidden = true;
    filterGroup.append(this.filtersBtn, this.filtersPopover);

    // Re-layout
    const relayoutBtn = button({ class: 'tb-btn tb-text', label: 'Re-layout', icon: uiIcon('relayout'), title: 'Reset node positions and re-layout', attrs: { 'aria-label': 'Re-layout' }, on: { click: () => this.cb.onRelayout() } });

    // Export
    const exportGroup = el('div', { class: 'tb-group tb-popover-host' });
    this.exportBtn = button({ class: 'tb-btn tb-text', label: 'Export', icon: uiIcon('download'), title: 'Export', attrs: { 'aria-haspopup': 'true', 'aria-expanded': 'false' }, on: { click: () => this.togglePopover('export') } });
    this.exportPopover = el('div', { class: 'tb-popover', attrs: { role: 'menu', 'aria-label': 'Export' } });
    this.exportPopover.hidden = true;
    this.exportPopover.append(
      this.menuItem('Export Markdown…', 'file', () => this.pick('markdown')),
      this.menuItem('Copy Mermaid (visible)', 'copy', () => this.pick('mermaid')),
      this.menuItem('Save SVG…', 'download', () => this.pick('svg')),
    );
    exportGroup.append(this.exportBtn, this.exportPopover);

    // Rescan + panel toggle
    const endGroup = el('div', { class: 'tb-group tb-end' });
    const rescanBtn = button({ class: 'tb-btn', icon: uiIcon('refresh'), title: 'Rescan workspace', attrs: { 'aria-label': 'Rescan workspace' }, on: { click: () => this.cb.onRescan() } });
    const panelBtn = button({ class: 'tb-btn', icon: uiIcon('panel'), title: 'Toggle details panel', attrs: { 'aria-label': 'Toggle details panel' }, on: { click: () => this.cb.onTogglePanel() } });
    endGroup.append(rescanBtn, panelBtn);

    this.el.append(searchWrap, view, layoutGroup, filterGroup, relayoutBtn, exportGroup, endGroup);

    document.addEventListener('pointerdown', (e) => {
      if (!this.el.contains(e.target as Node)) this.closePopovers();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePopovers();
    });
  }

  private directionLabel(): string {
    return this.direction === 'LR' ? 'Left→Right' : 'Top→Bottom';
  }

  private menuItem(label: string, iconName: Parameters<typeof uiIcon>[0], onClick: () => void): HTMLElement {
    return button({ class: 'tb-menu-item', label, icon: uiIcon(iconName), attrs: { role: 'menuitem' }, on: { click: onClick } });
  }

  private pick(kind: 'markdown' | 'mermaid' | 'svg'): void {
    this.closePopovers();
    this.cb.onExport(kind);
  }

  private togglePopover(which: 'filters' | 'export'): void {
    const open = which === 'filters' ? this.filtersPopover.hidden : this.exportPopover.hidden;
    this.closePopovers();
    if (which === 'filters' && open) {
      this.renderFilters();
      this.filtersPopover.hidden = false;
      this.filtersBtn.setAttribute('aria-expanded', 'true');
    } else if (which === 'export' && open) {
      this.exportPopover.hidden = false;
      this.exportBtn.setAttribute('aria-expanded', 'true');
    }
  }

  private closePopovers(): void {
    this.filtersPopover.hidden = true;
    this.exportPopover.hidden = true;
    this.filtersBtn.setAttribute('aria-expanded', 'false');
    this.exportBtn.setAttribute('aria-expanded', 'false');
  }

  // ── Public updates ───────────────────────────────────────────────────────────────────────────

  setZoom(scale: number): void {
    this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  setSearchStatus(current: number, total: number): void {
    this.searchCounter.textContent = total > 0 ? `${current} / ${total}` : this.searchInput.value.trim() ? '0 / 0' : '';
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  setColumnMode(mode: ColumnMode): void {
    this.columnSelect.value = mode;
  }

  setDirection(dir: Direction): void {
    this.direction = dir;
    const text = this.directionLabel();
    // keep the icon, replace trailing text node
    const last = this.directionBtn.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE) last.textContent = text;
  }

  setFilterOptions(schemas: FilterOption[], sources: FilterOption[], engines: FilterOption[]): void {
    this.schemas = schemas;
    this.sources = sources;
    this.engines = engines;
  }

  setFilters(filters: Filters): void {
    this.filters = filters;
    if (!this.filtersPopover.hidden) this.renderFilters();
  }

  private renderFilters(): void {
    const pop = this.filtersPopover;
    while (pop.firstChild) pop.removeChild(pop.firstChild);

    const emit = (): void => this.cb.onFiltersChange({ ...this.filters });

    const checkboxGroup = (title: string, options: FilterOption[], disabled: string[], onToggle: (value: string, checked: boolean) => void): HTMLElement | null => {
      if (!options.length) return null;
      const section = el('section', { class: 'filter-section' }, [el('h4', { class: 'filter-title', text: title })]);
      for (const opt of options) {
        const id = `flt-${title}-${opt.value}`.replace(/\W+/g, '-');
        const input = el('input', { type: 'checkbox', attrs: { id } });
        input.checked = !disabled.includes(opt.value);
        input.addEventListener('change', () => {
          onToggle(opt.value, input.checked);
          emit();
        });
        section.appendChild(el('label', { class: 'filter-row', attrs: { for: id } }, [input, el('span', { text: opt.label })]));
      }
      return section;
    };

    const toggleIn = (list: string[], value: string, checked: boolean): string[] =>
      checked ? list.filter((x) => x !== value) : list.includes(value) ? list : [...list, value];

    const s1 = checkboxGroup('Schemas', this.schemas, this.filters.disabledSchemas, (v, c) => (this.filters.disabledSchemas = toggleIn(this.filters.disabledSchemas, v, c)));
    const s2 = checkboxGroup('Sources', this.sources, this.filters.disabledSources, (v, c) => (this.filters.disabledSources = toggleIn(this.filters.disabledSources, v, c)));
    const s3 = checkboxGroup('Databases', this.engines, this.filters.disabledEngines, (v, c) => (this.filters.disabledEngines = toggleIn(this.filters.disabledEngines, v, c)));
    for (const s of [s1, s2, s3]) if (s) pop.appendChild(s);

    const toggles = el('section', { class: 'filter-section' }, [el('h4', { class: 'filter-title', text: 'Display' })]);
    const boolRow = (label: string, key: 'hideExternal' | 'hideInferred' | 'hideJoinTables'): HTMLElement => {
      const id = `flt-${key}`;
      const input = el('input', { type: 'checkbox', attrs: { id } });
      input.checked = this.filters[key];
      input.addEventListener('change', () => {
        this.filters[key] = input.checked;
        emit();
      });
      return el('label', { class: 'filter-row', attrs: { for: id } }, [input, el('span', { text: label })]);
    };
    toggles.append(boolRow('Hide external tables', 'hideExternal'), boolRow('Hide inferred relations', 'hideInferred'), boolRow('Hide join tables (show ↔ edges)', 'hideJoinTables'));

    const focusRow = el('div', { class: 'filter-row filter-focus' });
    focusRow.appendChild(el('span', { class: 'filter-focus-label', text: 'Focus mode' }));
    const focusSelect = el('select', { class: 'tb-select', attrs: { 'aria-label': 'Focus mode hops' } });
    for (const [value, text] of [['0', 'Off'], ['1', '1 hop'], ['2', '2 hops']] as const) {
      const o = el('option', { text, attrs: { value } });
      if (Number(value) === this.filters.focusHops) o.selected = true;
      focusSelect.appendChild(o);
    }
    focusSelect.addEventListener('change', () => {
      this.filters.focusHops = Number(focusSelect.value) as Filters['focusHops'];
      emit();
    });
    focusRow.appendChild(focusSelect);
    toggles.appendChild(focusRow);
    pop.appendChild(toggles);
  }
}

function iconSpan(name: Parameters<typeof uiIcon>[0]): HTMLElement {
  const span = el('span', { class: 'tb-icon', attrs: { 'aria-hidden': 'true' } });
  span.appendChild(uiIcon(name));
  return span;
}
