import * as vscode from 'vscode';
import { modelCounts, summaryText } from '../core/format';
import type { SchemaModel } from '../core/model';
import type { MapStatus } from '../core/protocol';

export interface StatusBarState {
  model: SchemaModel | undefined;
  status: MapStatus;
  /** A scan the user should see (initial scan or manual rescan) is running. */
  busy: boolean;
  enabled: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** `$(database) 12 tables` in the status bar; opens the DB Map on click. Hidden when nothing was found. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('dbnext.status', vscode.StatusBarAlignment.Left, 20);

  constructor() {
    this.item.name = 'DBNext';
  }

  update({ model, status, busy, enabled }: StatusBarState): void {
    const item = this.item;
    if (!enabled) {
      item.hide();
      return;
    }
    const counts = model ? modelCounts(model) : undefined;
    if (model && counts && counts.entities > 0) {
      const parts: string[] = [];
      if (counts.tables + counts.views) parts.push(plural(counts.tables + counts.views, 'table'));
      if (counts.collections) parts.push(plural(counts.collections, 'collection'));
      const label = parts.join(' · ');
      item.text = `${busy ? '$(sync~spin)' : '$(database)'} ${label}`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**DB Map**: ${summaryText(model)}\n\n`);
      if (model.engines.length) md.appendMarkdown(`Databases: ${model.engines.map((e) => e.label).join(', ')}\n\n`);
      if (model.sources.length) md.appendMarkdown(`Detected from: ${model.sources.map((s) => s.label).join(', ')}\n\n`);
      md.appendMarkdown('Click to open the interactive database map.');
      item.tooltip = md;
      item.command = 'dbnext.openMap';
      item.accessibilityInformation = { label: `DB Map: ${summaryText(model)}. Open the database map.`, role: 'button' };
      item.show();
    } else if (busy || status === 'scanning') {
      item.text = '$(sync~spin) DB Map';
      item.tooltip = 'DBNext is scanning the workspace for database schemas…';
      item.command = 'dbnext.showLog';
      item.accessibilityInformation = { label: 'DB Map: scanning the workspace for database schemas' };
      item.show();
    } else if (status === 'error') {
      item.text = '$(warning) DB Map';
      item.tooltip = 'The database scan failed. Click to show the log.';
      item.command = 'dbnext.showLog';
      item.accessibilityInformation = { label: 'DB Map: the scan failed. Show the log.', role: 'button' };
      item.show();
    } else {
      item.hide(); // no schema in this workspace: stay out of the way
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
