import * as vscode from 'vscode';
import { toMermaid } from '../core/export';
import { summaryText } from '../core/format';
import type { SchemaModel, SourceRef } from '../core/model';
import { sanitizeLayout, type Layout, type MapStatus } from '../core/protocol';
import { globGroup, includePatterns, type ParserRegistry } from '../core/scan';
import { CACHE_SETTINGS, SCAN_SETTINGS, readConfig, type DbNextConfig } from './config';
import { saveSvgFile, writeMarkdown } from './exporter';
import { Log } from './log';
import { MapPanel, type MapHost } from './mapPanel';
import { Scanner, excludeMatcher, type ScanOutput } from './scanner';
import { StatusBar } from './statusBar';
import { SchemaTreeProvider, isSchemaNode, sourceOf, type SchemaNode } from './treeView';

const LAYOUT_KEY = 'dbnext.layout';
const AUTO_OPENED_KEY = 'dbnext.autoOpened';
const EXPORTED_KEY = 'dbnext.exported';
const NO_SCHEMA = 'DBNext: no database schema has been found in this workspace yet.';

interface ScanRequest {
  delay?: number;
  /** Started by the user: show progress and report problems. */
  manual?: boolean;
  clearCache?: boolean;
}

function isSourceRef(value: unknown): value is SourceRef {
  const v = value as SourceRef | undefined;
  return !!v && typeof v === 'object' && typeof v.file === 'string' && typeof v.line === 'number';
}

function entityIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  return isSchemaNode(arg) && arg.type === 'entity' ? arg.entity.id : undefined;
}

function signature(m: SchemaModel): string {
  return JSON.stringify([m.entities, m.relations, m.enums, m.engines, m.sources, m.warnings]);
}

/** Owns the current schema model and keeps every view in sync with the workspace. */
export class Controller implements MapHost, vscode.Disposable {
  readonly log = new Log();
  model: SchemaModel | undefined;
  status: MapStatus = 'scanning';
  statusMessage: string | undefined;
  readonly onDidChange: vscode.Event<void>;

  private uris = new Map<string, vscode.Uri>();
  private modelSignature = '';
  private config: DbNextConfig;
  private excluded: RegExp;
  private readonly scanner: Scanner;
  private readonly tree = new SchemaTreeProvider();
  private readonly treeView: vscode.TreeView<SchemaNode>;
  private readonly statusBar = new StatusBar();
  private readonly changed = new vscode.EventEmitter<void>();
  private cts: vscode.CancellationTokenSource | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private manualPending = false;
  private visibleBusy = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watcherGlob = '';
  private initialDone = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ParserRegistry,
  ) {
    this.onDidChange = this.changed.event;
    this.config = readConfig();
    this.excluded = excludeMatcher(this.config);
    this.scanner = new Scanner(registry, this.log);
    this.treeView = vscode.window.createTreeView('dbnext.schema', { treeDataProvider: this.tree, showCollapseAll: true });
    this.disposables.push(
      this.log,
      this.tree,
      this.treeView,
      this.statusBar,
      this.changed,
      vscode.window.registerWebviewPanelSerializer(MapPanel.viewType, {
        deserializeWebviewPanel: async (panel) => {
          MapPanel.revive(panel, this);
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChange(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.requestScan({ delay: 300, clearCache: true })),
      ...this.registerCommands(),
    );
  }

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  start(): void {
    const version = String(this.context.extension.packageJSON?.version ?? '');
    this.log.info(`DBNext ${version} started; ${this.registry.parsers.length} schema parsers available.`);
    this.refreshChrome();
    this.updateWatcher();
    this.requestScan();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    const cts = this.cts;
    this.cts = undefined;
    cts?.cancel();
    this.watcher?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  // ── commands ──

  private registerCommands(): vscode.Disposable[] {
    const reg = vscode.commands.registerCommand;
    return [
      reg('dbnext.openMap', (arg?: unknown) => this.openMap(entityIdOf(arg))),
      reg('dbnext.revealInMap', (arg?: unknown) => this.openMap(entityIdOf(arg))),
      reg('dbnext.rescan', () => this.requestScan({ manual: true, clearCache: true })),
      reg('dbnext.exportMarkdown', () => this.exportMarkdown()),
      reg('dbnext.copyMermaid', () => this.copyMermaid()),
      reg('dbnext.openSource', (arg?: unknown) => this.openSourceArg(arg)),
      reg('dbnext.showLog', () => this.log.show()),
      reg('dbnext.revealEntity', (id?: unknown) => this.revealEntity(id)),
    ];
  }

  openMap(entityId?: string): void {
    MapPanel.show(this, { focus: entityId });
  }

  private async openSourceArg(arg: unknown): Promise<void> {
    const ref = isSchemaNode(arg) ? sourceOf(arg) : isSourceRef(arg) ? arg : undefined;
    if (ref) await this.openSource(ref, false);
  }

  private async revealEntity(id: unknown): Promise<void> {
    if (typeof id !== 'string') return;
    const node = this.tree.nodeForEntity(id);
    if (node) await this.treeView.reveal(node, { select: true, focus: true, expand: true });
  }

  async exportMarkdown(): Promise<void> {
    const model = this.model;
    if (!model?.entities.length) {
      void vscode.window.showInformationMessage(NO_SCHEMA);
      return;
    }
    try {
      const result = await writeMarkdown(this.markdownTarget(model, this.config));
      if (!result) {
        void vscode.window.showWarningMessage('DBNext: open a folder to export the database map.');
        return;
      }
      await this.context.workspaceState.update(EXPORTED_KEY, true);
      const rel = vscode.workspace.asRelativePath(result.uri);
      this.log.info(`Exported the database map to ${rel}.`);
      const pick = await vscode.window.showInformationMessage(`DBNext: database map written to ${rel}.`, 'Open Preview', 'Open File');
      if (pick === 'Open Preview') await vscode.commands.executeCommand('markdown.showPreview', result.uri);
      else if (pick === 'Open File') await vscode.window.showTextDocument(result.uri);
    } catch (e) {
      this.log.error('Markdown export failed', e);
      void vscode.window.showErrorMessage(`DBNext: could not write the Markdown file (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  // ── MapHost ──

  async copyMermaid(entityIds?: string[]): Promise<void> {
    const model = this.model;
    if (!model?.entities.length) {
      void vscode.window.showInformationMessage(NO_SCHEMA);
      return;
    }
    const known = new Set(model.entities.map((e) => e.id));
    const ids = entityIds?.filter((id) => known.has(id));
    const subset = ids?.length ? ids : undefined;
    await vscode.env.clipboard.writeText(toMermaid(model, { entityIds: subset }));
    const n = subset?.length ?? model.entities.length;
    void vscode.window.showInformationMessage(
      `DBNext: copied a Mermaid ER diagram of ${n} ${n === 1 ? 'table' : 'tables'}. Paste it into any Markdown file; GitHub and GitLab render it.`,
    );
  }

  async saveSvg(svg: string): Promise<void> {
    try {
      const uri = await saveSvgFile(svg);
      if (!uri) return;
      const pick = await vscode.window.showInformationMessage(`DBNext: diagram saved to ${vscode.workspace.asRelativePath(uri)}.`, 'Open');
      if (pick) await vscode.commands.executeCommand('vscode.open', uri);
    } catch (e) {
      this.log.error('SVG export failed', e);
      void vscode.window.showErrorMessage('DBNext: could not save the SVG file. See the log for details.');
    }
  }

  runCommand(command: 'dbnext.rescan' | 'dbnext.exportMarkdown' | 'dbnext.showLog'): void {
    void vscode.commands.executeCommand(command);
  }

  getLayout(): Layout {
    return sanitizeLayout(this.context.workspaceState.get(LAYOUT_KEY)) ?? {};
  }

  saveLayout(layout: Layout): void {
    void this.context.workspaceState.update(LAYOUT_KEY, layout);
  }

  async openSource(ref: SourceRef, beside: boolean): Promise<void> {
    const uri = this.resolveFile(ref.file);
    if (!uri) {
      void vscode.window.showWarningMessage(`DBNext: "${ref.file}" is not part of the workspace.`);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, Math.min(doc.lineCount - 1, Math.floor(ref.line) || 0));
      const pos = new vscode.Position(line, doc.lineAt(line).firstNonWhitespaceCharacterIndex);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        viewColumn: beside ? vscode.ViewColumn.Beside : undefined,
        preview: true,
      });
    } catch (e) {
      this.log.error(`Could not open ${ref.file}`, e);
      void vscode.window.showErrorMessage(`DBNext: could not open "${ref.file}".`);
    }
  }

  /** Maps a workspace-relative path from the model back to a URI inside a workspace folder. */
  private resolveFile(file: string): vscode.Uri | undefined {
    const known = this.uris.get(file);
    if (known) return known;
    const segments = file.split('/');
    if (!file || segments.some((s) => s === '' || s === '.' || s === '..')) return undefined;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) return vscode.Uri.joinPath(folders[0].uri, ...segments);
    const folder = folders.find((f) => f.name === segments[0]);
    return folder && segments.length > 1 ? vscode.Uri.joinPath(folder.uri, ...segments.slice(1)) : undefined;
  }

  private markdownTarget(model: SchemaModel, config: DbNextConfig) {
    return { model, resolve: (file: string) => this.resolveFile(file), exportPath: config.exportPath };
  }

  // ── scanning ──

  requestScan(request: ScanRequest = {}): void {
    if (request.clearCache) this.scanner.clearCache();
    if (request.manual) this.manualPending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScan();
    }, request.delay ?? 0);
  }

  private async runScan(): Promise<void> {
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    const manual = this.manualPending;
    this.manualPending = false;
    const config = (this.config = readConfig());
    this.excluded = excludeMatcher(config);
    const visible = manual || !this.model;
    if (visible) {
      this.visibleBusy = true;
      this.status = 'scanning';
      this.statusMessage = undefined;
      this.refreshChrome();
      this.changed.fire();
    }

    let out: ScanOutput | undefined;
    let failure: unknown;
    try {
      out = await vscode.window.withProgress({ location: { viewId: 'dbnext.schema' } }, () => this.scanner.scan(config, cts.token));
    } catch (e) {
      failure = e ?? new Error('Unknown error');
    }
    cts.dispose();
    if (this.cts !== cts) return; // superseded by a newer scan, or disposed
    this.cts = undefined;
    this.visibleBusy = false;

    if (out) {
      const sig = signature(out.model);
      const same = !!this.model && sig === this.modelSignature;
      this.uris = out.uris;
      if (!same) {
        this.model = out.model;
        this.modelSignature = sig;
      }
      this.status = out.model.entities.length ? 'ready' : 'empty';
      this.statusMessage = undefined;
      if (visible || !same) this.logScan(out.model, visible);
      if (same && !visible) return; // background rescan without visible changes
    } else if (failure !== undefined) {
      this.log.error('Scan failed', failure);
      if (this.model) {
        this.status = this.model.entities.length ? 'ready' : 'empty';
        if (manual) {
          void vscode.window.showWarningMessage('DBNext: the rescan failed. See the log for details.', 'Show Log').then((pick) => {
            if (pick) this.log.show();
          });
        }
      } else {
        this.status = 'error';
        this.statusMessage = failure instanceof Error ? failure.message : String(failure);
      }
    } else {
      return;
    }

    this.tree.setModel(this.model);
    this.refreshChrome();
    this.changed.fire();
    await this.afterScan(config);
  }

  private logScan(model: SchemaModel, detailed: boolean): void {
    const s = model.stats;
    this.log.info(
      `Scan finished in ${s.durationMs} ms: ${summaryText(model)}. Read ${s.filesRead} of ${s.filesFound} candidate files; ` +
        `${s.filesParsed} contain schema definitions${s.truncated ? ' (file limit reached)' : ''}.`,
    );
    if (!detailed) return;
    if (model.sources.length) {
      this.log.info(`Detected from: ${model.sources.map((x) => `${x.label} (${x.files} files, ${x.entities} entities)`).join(', ')}.`);
    }
    if (model.engines.length) this.log.info(`Databases: ${model.engines.map((e) => e.label).join(', ')}.`);
    for (const w of model.warnings.slice(0, 200)) {
      const where = w.file ? `${w.file}${w.line !== undefined ? `:${w.line + 1}` : ''}: ` : '';
      const message = w.message.length > 500 ? `${w.message.slice(0, 499)}…` : w.message;
      this.log.warn(`${where}${message}`);
    }
  }

  private async afterScan(config: DbNextConfig): Promise<void> {
    if (!this.initialDone) {
      this.initialDone = true;
      this.maybeAutoOpen(config);
    }
    const model = this.model;
    if (!config.exportAutoUpdate || !model?.entities.length) return;
    try {
      const exported = this.context.workspaceState.get<boolean>(EXPORTED_KEY) === true;
      const result = await writeMarkdown(this.markdownTarget(model, config), { onlyIfChanged: true, onlyIfExists: !exported });
      if (result?.written) this.log.info(`Updated ${vscode.workspace.asRelativePath(result.uri)}.`);
    } catch (e) {
      this.log.error('Automatic Markdown export failed', e);
    }
  }

  private maybeAutoOpen(config: DbNextConfig): void {
    if (config.autoOpen === 'never' || MapPanel.current) return;
    if (!this.model?.entities.some((e) => !e.external)) return;
    if (config.autoOpen === 'firstTime') {
      if (this.context.workspaceState.get<boolean>(AUTO_OPENED_KEY)) return;
      void this.context.workspaceState.update(AUTO_OPENED_KEY, true);
    }
    this.log.info('Opening the DB Map automatically (setting "dbnext.autoOpen").');
    MapPanel.show(this, { preserveFocus: true });
  }

  private refreshChrome(): void {
    const model = this.model;
    const hasEntities = !!model?.entities.length;
    const state = hasEntities ? 'ready' : this.status === 'scanning' ? 'scanning' : this.status === 'error' ? 'error' : 'empty';
    void vscode.commands.executeCommand('setContext', 'dbnext.state', state);
    this.statusBar.update({ model, status: this.status, busy: this.visibleBusy, enabled: this.config.statusBar });
    this.treeView.description = model && hasEntities ? summaryText(model) : undefined;
  }

  // ── settings and file watching ──

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('dbnext') && !e.affectsConfiguration('files.exclude')) return;
    this.config = readConfig();
    this.excluded = excludeMatcher(this.config);
    if (CACHE_SETTINGS.some((s) => e.affectsConfiguration(s))) this.scanner.clearCache();
    if (SCAN_SETTINGS.some((s) => e.affectsConfiguration(s))) this.requestScan({ delay: 400 });
    if (e.affectsConfiguration('dbnext.watch')) this.updateWatcher();
    if (e.affectsConfiguration('dbnext.statusBar')) this.refreshChrome();
  }

  private updateWatcher(): void {
    if (!this.config.watch) {
      this.watcher?.dispose();
      this.watcher = undefined;
      this.watcherGlob = '';
      return;
    }
    const glob = globGroup(includePatterns(this.registry));
    if (!glob || (this.watcher && glob === this.watcherGlob)) return;
    this.watcher?.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    const onEvent = (uri: vscode.Uri) => this.onFileEvent(uri);
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    this.watcher = watcher;
    this.watcherGlob = glob;
  }

  private onFileEvent(uri: vscode.Uri): void {
    if (this.excluded.test(vscode.workspace.asRelativePath(uri, false))) return;
    this.scanner.invalidate(uri);
    this.requestScan({ delay: 1000 });
  }
}
