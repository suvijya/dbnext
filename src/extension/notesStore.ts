import * as vscode from 'vscode';
import { NOTES_PATH, emptyNotes, parseNotes, serializeNotes, type Notes } from '../core/notes';

/** Reads and writes `.dbnext/notes.json` in the first workspace folder. */
export class NotesStore implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly onExternalChange: () => void) {}

  private uri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ...NOTES_PATH.split('/')) : undefined;
  }

  /** Starts watching the file (call once after construction). */
  watch(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || this.watcher) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, NOTES_PATH));
    this.watcher = w;
    this.disposables.push(w, w.onDidChange(this.onExternalChange), w.onDidCreate(this.onExternalChange), w.onDidDelete(this.onExternalChange));
  }

  /** Missing, unreadable or invalid files give empty notes. */
  async load(): Promise<Notes> {
    const uri = this.uri();
    if (!uri) return emptyNotes();
    try {
      return parseNotes(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    } catch {
      return emptyNotes();
    }
  }

  async save(notes: Notes): Promise<void> {
    const uri = this.uri();
    if (!uri) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeNotes(notes)));
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
