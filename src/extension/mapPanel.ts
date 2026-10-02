import * as vscode from 'vscode';
import type { SchemaModel, SourceRef } from '../core/model';
import { sanitizeLayout, type HostMessage, type Layout, type MapStatus } from '../core/protocol';

/** What the panel needs from the extension (implemented by the Controller). */
export interface MapHost {
  readonly extensionUri: vscode.Uri;
  readonly model: SchemaModel | undefined;
  readonly status: MapStatus;
  readonly statusMessage: string | undefined;
  readonly onDidChange: vscode.Event<void>;
  getLayout(): Layout;
  saveLayout(layout: Layout): void;
  openSource(ref: SourceRef, beside: boolean): Promise<void>;
  runCommand(command: 'dbnext.rescan' | 'dbnext.exportMarkdown' | 'dbnext.showLog'): void;
  copyMermaid(entityIds?: string[]): Promise<void>;
  saveSvg(svg: string): Promise<void>;
}

export interface ShowOptions {
  /** Entity id to select and centre. */
  focus?: string;
  preserveFocus?: boolean;
}

const MAX_SVG_LENGTH = 50 * 1024 * 1024;

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

function resourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')];
}

function isSourceRef(value: unknown): value is SourceRef {
  const v = value as SourceRef | undefined;
  return !!v && typeof v.file === 'string' && v.file.length < 4096 && typeof v.line === 'number' && Number.isFinite(v.line);
}

/** The interactive ER diagram editor tab ("DB Map"). Only one exists at a time. */
export class MapPanel implements vscode.Disposable {
  static readonly viewType = 'dbnext.map';
  private static instance: MapPanel | undefined;

  static get current(): MapPanel | undefined {
    return MapPanel.instance;
  }

  static show(host: MapHost, options: ShowOptions = {}): MapPanel {
    const existing = MapPanel.instance;
    if (existing) {
      existing.panel.reveal(undefined, options.preserveFocus);
      if (options.focus) existing.focus(options.focus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      MapPanel.viewType,
      'DB Map',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: !!options.preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots(host.extensionUri) },
    );
    const map = new MapPanel(panel, host);
    if (options.focus) map.focus(options.focus);
    return map;
  }

  /** Re-attaches to a panel restored by VS Code after a window reload. */
  static revive(panel: vscode.WebviewPanel, host: MapHost): MapPanel {
    MapPanel.instance?.dispose();
    return new MapPanel(panel, host);
  }

  private ready = false;
  private disposed = false;
  private pendingFocus: string | undefined;
  private sentModel: SchemaModel | undefined;
  private sentStatus: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: MapHost,
  ) {
    MapPanel.instance = this;
    panel.iconPath = vscode.Uri.joinPath(host.extensionUri, 'media', 'dbnext.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(host.extensionUri) };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      host.onDidChange(() => this.sync(false)),
    );
  }

  /** Selects and centres an entity (queued until the webview has a model). */
  focus(entityId: string): void {
    if (this.ready && this.sentModel) this.post({ type: 'focus', entityId });
    else this.pendingFocus = entityId;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (MapPanel.instance === this) MapPanel.instance = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private sync(force: boolean): void {
    if (!this.ready || this.disposed) return;
    const status = `${this.host.status}|${this.host.statusMessage ?? ''}`;
    if (force || status !== this.sentStatus) {
      this.sentStatus = status;
      this.post({ type: 'status', status: this.host.status, message: this.host.statusMessage });
    }
    const model = this.host.model;
    if (model && (force || model !== this.sentModel)) {
      this.sentModel = model;
      const focus = this.pendingFocus;
      this.pendingFocus = undefined;
      this.post({ type: 'model', model, layout: this.host.getLayout(), ...(focus ? { focus } : {}) });
    }
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as { type?: unknown; [key: string]: unknown };
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sync(true);
        break;
      case 'openSource':
        if (isSourceRef(m.ref)) void this.host.openSource(m.ref, true);
        break;
      case 'rescan':
        this.host.runCommand('dbnext.rescan');
        break;
      case 'exportMarkdown':
        this.host.runCommand('dbnext.exportMarkdown');
        break;
      case 'showLog':
        this.host.runCommand('dbnext.showLog');
        break;
      case 'copyMermaid': {
        const ids = Array.isArray(m.entityIds) ? m.entityIds.filter((x): x is string => typeof x === 'string') : undefined;
        void this.host.copyMermaid(ids);
        break;
      }
      case 'saveLayout': {
        const layout = sanitizeLayout(m.layout);
        if (layout) this.host.saveLayout(layout);
        break;
      }
      case 'exportSvg':
        if (typeof m.svg === 'string' && m.svg.length <= MAX_SVG_LENGTH && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(m.svg)) {
          void this.host.saveSvg(m.svg);
        }
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.host.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>DB Map</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
