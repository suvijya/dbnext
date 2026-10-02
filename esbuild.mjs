// Build script for DBNext.
// Produces three bundles:
//   dist/extension.js      – extension host (Node, desktop VS Code)
//   dist/web/extension.js  – extension host (browser, vscode.dev / github.dev)
//   dist/webview/main.js   – ER diagram UI running inside the webview (+ main.css)
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/web/extension.js',
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
    mainFields: ['browser', 'module', 'main'],
  },
  {
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'css' },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[dbnext] watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
