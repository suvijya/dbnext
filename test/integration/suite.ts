/**
 * Integration smoke test, executed inside a real VS Code instance by runTest.mjs against a temporary
 * copy of test/integration/fixture. Plain node:assert, no test framework needed.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DbNextApi } from '../../src/extension/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, probe: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a workspace folder is open');
  const ext = vscode.extensions.getExtension<DbNextApi>('suvijya.dbnext');
  assert.ok(ext, 'extension is installed');
  let api!: DbNextApi;

  console.log('DBNext integration tests');

  await step('activates on startup and scans the workspace automatically', async () => {
    api = ext.isActive ? ext.exports : await ext.activate();
    await until('scan', () => api.status === 'ready' && api.model);
  });

  await step('maps Prisma, Mongoose and docker compose engines', async () => {
    const m = api.model!;
    const ids = m.entities.map((e) => e.id).sort();
    assert.deepEqual(ids, ['doc:auditevents', 'post', 'profile', 'user']);
    const rel = (from: string, to: string) => m.relations.find((r) => r.from === from && r.to === to);
    assert.equal(rel('post', 'user')?.cardinality, 'many-to-one');
    assert.equal(rel('post', 'user')?.onDelete?.toUpperCase(), 'CASCADE');
    assert.equal(rel('profile', 'user')?.cardinality, 'one-to-one');
    const engines = m.engines.map((e) => e.id).sort();
    for (const e of ['mongodb', 'postgresql', 'redis']) assert.ok(engines.includes(e as never), `engine ${e} in ${engines}`);
  });

  await step('registers every contributed command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['dbnext.openMap', 'dbnext.rescan', 'dbnext.exportMarkdown', 'dbnext.copyMermaid', 'dbnext.revealInMap', 'dbnext.openSource', 'dbnext.showLog']) {
      assert.ok(all.includes(c), c);
    }
  });

  await step('opens the DB Map webview', async () => {
    await vscode.commands.executeCommand('dbnext.openMap');
    await until('DB Map tab', () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('dbnext.map')),
    );
  });

  await step('copies a Mermaid ER diagram to the clipboard', async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('dbnext.copyMermaid');
    const text = await vscode.env.clipboard.readText();
    assert.match(text, /^erDiagram/);
    assert.match(text, /post }o--\|\| user/i);
  });

  await step('exports DBMAP.md', async () => {
    const uri = vscode.Uri.joinPath(folder.uri, 'DBMAP.md');
    void vscode.commands.executeCommand('dbnext.exportMarkdown'); // resolves only when its notification is dismissed
    let bytes: Uint8Array | undefined;
    for (let i = 0; i < 100 && !bytes; i++) {
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        await sleep(200);
      }
    }
    assert.ok(bytes, 'DBMAP.md was written');
    const md = new TextDecoder().decode(bytes);
    assert.match(md, /# Database map/);
    assert.match(md, /```mermaid/);
    assert.match(md, /\[`prisma\/schema\.prisma:\d+`\]\(prisma\/schema\.prisma#L\d+\)/);
  });

  await step('updates the map when a schema file is added (file watcher)', async () => {
    const uri = vscode.Uri.joinPath(folder.uri, 'db', 'extra.sql');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('CREATE TABLE audit_log (id serial PRIMARY KEY, user_id int REFERENCES "User"(id));\n'));
    await until('audit_log entity', () => api.model?.entities.some((e) => e.id === 'audit_log'), 20_000);
    assert.ok(api.model!.relations.some((r) => r.from === 'audit_log' && r.to === 'user'));
  });

  await step('rescan keeps the model and "Go to definition" opens the source', async () => {
    await vscode.commands.executeCommand('dbnext.rescan');
    await until('rescan', () => api.status === 'ready' && api.model?.entities.length === 5);
    const user = api.model!.entities.find((e) => e.id === 'user')!;
    assert.ok(user.source);
    await vscode.commands.executeCommand('dbnext.openSource', user.source);
    const editor = await until('editor', () => vscode.window.activeTextEditor);
    assert.match(editor.document.uri.path, /prisma\/schema\.prisma$/);
    assert.equal(editor.selection.active.line, user.source!.line);
  });

  await step('removes an entity when its schema file is deleted (cache invalidation)', async () => {
    const uri = vscode.Uri.joinPath(folder.uri, 'db', 'extra.sql');
    await vscode.workspace.fs.delete(uri);
    await until('audit_log to disappear', () => (api.model && !api.model.entities.some((e) => e.id === 'audit_log') ? true : undefined), 20_000);
    assert.equal(api.model!.entities.length, 4);
  });

  await step('re-reads a file whose size did not change (watcher-driven cache invalidation)', async () => {
    const uri = vscode.Uri.joinPath(folder.uri, 'db', 'rapid.sql');
    const enc = (s: string) => new TextEncoder().encode(s);
    const a = 'CREATE TABLE rapid_aaa (id int);\n';
    const z = 'CREATE TABLE rapid_zzz (id int);\n';
    assert.equal(a.length, z.length); // identical byte length: only mtime/content differ
    await vscode.workspace.fs.writeFile(uri, enc(a));
    await until('rapid_aaa', () => api.model?.entities.some((e) => e.id === 'rapid_aaa'), 20_000);
    await vscode.workspace.fs.writeFile(uri, enc(z));
    await until(
      'rapid_zzz to replace rapid_aaa',
      () => (api.model?.entities.some((e) => e.id === 'rapid_zzz') && !api.model.entities.some((e) => e.id === 'rapid_aaa') ? true : undefined),
      20_000,
    );
  });

  await step('exports to a path inside a folder that does not exist yet', async () => {
    await vscode.workspace.getConfiguration('dbnext').update('export.path', 'docs/generated/DB MAP.md', vscode.ConfigurationTarget.Workspace);
    await sleep(1000); // let onDidChangeConfiguration refresh the controller's cached config
    const target = vscode.Uri.joinPath(folder.uri, 'docs', 'generated', 'DB MAP.md');
    void vscode.commands.executeCommand('dbnext.exportMarkdown');
    let bytes: Uint8Array | undefined;
    for (let i = 0; i < 100 && !bytes; i++) {
      try {
        bytes = await vscode.workspace.fs.readFile(target);
      } catch {
        await sleep(200);
      }
    }
    assert.ok(bytes, 'export created the missing directories and wrote the file');
    assert.match(new TextDecoder().decode(bytes), /```mermaid/);
  });

  console.log('All integration tests passed.');
}
