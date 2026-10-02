// Runs the integration suites inside VS Code.
//   node test/integration/runTest.mjs
// Uses a locally installed VS Code when found (or VSCODE_EXECUTABLE). Set DBNEXT_IT_DOWNLOAD=1 to
// force an isolated download into .vscode-test/ instead (useful when the local install is busy
// updating, or on CI). Each suite is bundled separately and launched in its own VS Code instance
// against a fresh copy of its fixture, so the repository stays untouched.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/**
 * The integration suites. Each runs in its own VS Code window.
 * `open` turns the copied fixture directory into the path passed to VS Code (a folder for
 * single-root workspaces, a `.code-workspace` file for multi-root ones).
 */
const SUITES = [
  { name: 'suite', entry: 'suite.ts', fixture: 'fixture', open: (ws) => ws },
  { name: 'multiroot', entry: 'multiroot.suite.ts', fixture: 'multiroot', open: (ws) => join(ws, 'dbnext.code-workspace') },
];

async function bundle(entry, outFile) {
  await esbuild.build({
    entryPoints: [join(here, entry)],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    external: ['vscode'],
    logLevel: 'warning',
  });
}

function localVsCode() {
  if (process.env.VSCODE_EXECUTABLE) return process.env.VSCODE_EXECUTABLE;
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), 'C:\\Program Files\\Microsoft VS Code\\Code.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code'];
  return candidates.find((p) => p && existsSync(p));
}

// `DBNEXT_IT_DOWNLOAD=1` → download an isolated VS Code; otherwise prefer the local install and let
// test-electron download only when none is found.
const vscodeExecutablePath = process.env.DBNEXT_IT_DOWNLOAD ? await downloadAndUnzipVSCode() : localVsCode();

let failed = false;
for (const suite of SUITES) {
  if (!existsSync(join(here, suite.entry))) continue;
  const out = join(root, 'dist', 'test', `${suite.name}.js`);
  await bundle(suite.entry, out);

  const temp = mkdtempSync(join(tmpdir(), `dbnext-it-${suite.name}-`));
  const workspace = join(temp, 'workspace');
  cpSync(join(here, suite.fixture), workspace, { recursive: true });

  try {
    console.log(`\n── integration suite: ${suite.name} ──`);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: out,
      launchArgs: [suite.open(workspace), '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${join(temp, 'user-data')}`],
    });
  } catch (e) {
    failed = true;
    console.error(`Integration suite "${suite.name}" failed:`, e instanceof Error ? e.message : e);
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // VS Code may still hold files for a moment on Windows
    }
  }
}
process.exit(failed ? 1 : 0);
