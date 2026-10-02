import * as vscode from 'vscode';
import { stripVolatile, toMarkdown } from '../core/export';
import type { SchemaModel, SourceRef } from '../core/model';
import { relativePath } from '../core/scan';

export const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=suvijya.dbnext';

/** Windows drive paths may differ in drive-letter case (`/c:/` vs `/C:/`). */
function ignoreCase(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && /^\/[a-z]:\//i.test(uri.path);
}

export interface MarkdownTarget {
  model: SchemaModel;
  /** Maps a `SourceRef.file` to its URI. */
  resolve(file: string): vscode.Uri | undefined;
  /** Workspace-relative path (already sanitized). */
  exportPath: string;
}

export interface MarkdownWriteOptions {
  /** Do not write when only the timestamp / duration would change. */
  onlyIfChanged?: boolean;
  /** Do not create the file, only update an existing one. */
  onlyIfExists?: boolean;
}

/** Writes the Markdown database map into the first workspace folder. */
export async function writeMarkdown(
  target: MarkdownTarget,
  options: MarkdownWriteOptions = {},
): Promise<{ uri: vscode.Uri; written: boolean } | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const uri = vscode.Uri.joinPath(folder.uri, ...target.exportPath.split('/'));
  const dir = vscode.Uri.joinPath(uri, '..');
  const text = toMarkdown(target.model, {
    generatorUrl: MARKETPLACE_URL,
    fileLink: (ref: SourceRef) => {
      const file = target.resolve(ref.file);
      if (!file || file.scheme !== uri.scheme || file.authority !== uri.authority) return undefined;
      return `${relativePath(dir.path, file.path, ignoreCase(file))}#L${ref.line + 1}`;
    },
  });

  let existing: string | undefined;
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    existing = undefined;
  }
  if (options.onlyIfExists && existing === undefined) return { uri, written: false };
  if (options.onlyIfChanged && existing !== undefined && stripVolatile(existing) === stripVolatile(text)) {
    return { uri, written: false };
  }
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  return { uri, written: true };
}

/** Asks where to save and writes an SVG document produced by the webview. */
export async function saveSvgFile(svg: string): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'dbmap.svg') : undefined,
    filters: { 'SVG image': ['svg'] },
    saveLabel: 'Export',
    title: 'Export DB Map as SVG',
  });
  if (!uri) return undefined;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(svg));
  return uri;
}
