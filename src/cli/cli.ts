/**
 * `dbnext` command line: scans a directory for database schemas (same parsers and defaults as the
 * extension) and prints / writes the result. Node only; never imported by the extension bundles.
 *
 *   dbnext scan <dir> [--format md|mermaid|dbml|plantuml|json] [--out file]
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { toMarkdown, toMermaid } from '../core/export';
import { toDbml, toPlantUml } from '../core/exportDiagrams';
import type { EngineHint, FileResult, SchemaModel } from '../core/model';
import { buildModel } from '../core/resolve';
import { DEFAULT_EXCLUDES, decodeText, globToRegExp, includePatterns, parseFile } from '../core/scan';
import { registry } from '../parsers';

const FORMATS = ['md', 'mermaid', 'dbml', 'plantuml', 'json'] as const;
type Format = (typeof FORMATS)[number];

const MAX_FILE_BYTES = 2048 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const USAGE = `Usage: dbnext scan <dir> [--format md|mermaid|dbml|plantuml|json] [--out file]

  --format, -f  Output format (default: md)
  --out, -o     Write to a file instead of stdout
  --help, -h    Show this help
`;

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) visit(join(dir, d.name), path);
      } else if (d.isFile()) {
        out.push(path);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

export function scanDirectory(root: string, name = basename(root)): SchemaModel {
  const started = Date.now();
  const include = globToRegExp(includePatterns(registry));
  const exclude = globToRegExp(DEFAULT_EXCLUDES);
  const candidates = walk(root).filter((p) => include.test(p) && !exclude.test(p));
  const results: FileResult[] = [];
  const engineHints: { file: string; hint: EngineHint }[] = [];
  const warnings: { file: string; message: string }[] = [];
  let filesRead = 0;
  let filesParsed = 0;
  for (const rel of candidates) {
    const abs = join(root, rel);
    if (statSync(abs).size > MAX_FILE_BYTES) continue;
    const text = decodeText(readFileSync(abs));
    if (text === undefined) continue;
    filesRead++;
    const o = parseFile({ path: rel, text }, registry);
    if (o.results.length) filesParsed++;
    results.push(...o.results);
    for (const hint of o.hints) engineHints.push({ file: rel, hint });
    for (const message of o.errors) warnings.push({ file: rel, message });
  }
  return buildModel({
    workspaceName: name,
    results,
    engineHints,
    warnings,
    inferRelations: true,
    now: new Date(),
    stats: { filesFound: candidates.length, filesRead, filesParsed, durationMs: Date.now() - started, truncated: false },
  });
}

export function render(model: SchemaModel, format: Format): string {
  switch (format) {
    case 'md':
      return toMarkdown(model, { generatorUrl: 'https://github.com/suvijya/dbnext' });
    case 'mermaid':
      return `${toMermaid(model)}\n`;
    case 'dbml':
      return toDbml(model);
    case 'plantuml':
      return toPlantUml(model);
    case 'json':
      return `${JSON.stringify(model, null, 2)}\n`;
  }
}

export function main(argv: string[]): number {
  const args = [...argv];
  const cmd = args.shift();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd !== 'scan') {
    process.stderr.write(`dbnext: unknown command '${cmd}'\n\n${USAGE}`);
    return 1;
  }
  let dir: string | undefined;
  let format: Format = 'md';
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else if (a === '--format' || a === '-f' || a.startsWith('--format=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (!v || !(FORMATS as readonly string[]).includes(v)) {
        process.stderr.write(`dbnext: --format must be one of ${FORMATS.join(', ')}\n`);
        return 1;
      }
      format = v as Format;
    } else if (a === '--out' || a === '-o' || a.startsWith('--out=')) {
      out = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (!out) {
        process.stderr.write('dbnext: --out needs a file path\n');
        return 1;
      }
    } else if (a.startsWith('-')) {
      process.stderr.write(`dbnext: unknown option '${a}'\n`);
      return 1;
    } else if (dir === undefined) {
      dir = a;
    } else {
      process.stderr.write(`dbnext: unexpected argument '${a}'\n`);
      return 1;
    }
  }
  if (!dir) {
    process.stderr.write(`dbnext: missing <dir>\n\n${USAGE}`);
    return 1;
  }
  const root = resolve(dir);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`dbnext: cannot read directory '${dir}'\n`);
    return 1;
  }
  const model = scanDirectory(root);
  const text = render(model, format);
  if (out) {
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    process.stderr.write(`dbnext: wrote ${model.entities.length} tables, ${model.relations.length} relations to ${out}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
