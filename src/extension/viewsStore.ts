import * as vscode from 'vscode';
import { VIEWS_PATH, parseViews, serializeViews, type SavedView } from '../core/views';

/** Reads and writes `.dbnext/views.json` in the first workspace folder. */
export class ViewsStore implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly onExternalChange: () => void) {}

  private uri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ...VIEWS_PATH.split('/')) : undefined;
  }

  /** Starts watching the file (call once after construction). */
  watch(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || this.watcher) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, VIEWS_PATH));
    this.watcher = w;
    this.disposables.push(w, w.onDidChange(this.onExternalChange), w.onDidCreate(this.onExternalChange), w.onDidDelete(this.onExternalChange));
  }

  /** Missing, unreadable or invalid files give no views. */
  async load(): Promise<SavedView[]> {
    const uri = this.uri();
    if (!uri) return [];
    try {
      return parseViews(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    } catch {
      return [];
    }
  }

  async save(views: readonly SavedView[]): Promise<void> {
    const uri = this.uri();
    if (!uri) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeViews(views)));
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
