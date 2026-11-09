/**
 * Headless scan harness: walks a directory the way the extension does (default excludes, include
 * patterns, size limit), runs the parsers and builds the model. Used by the e2e regression suite.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '../../src/parsers';
import { buildModel } from '../../src/core/resolve';
import { DEFAULT_EXCLUDES, decodeText, globToRegExp, includePatterns, parseFile } from '../../src/core/scan';
import type { EngineHint, FileResult, SchemaModel } from '../../src/core/model';

const MAX_FILE_BYTES = 2048 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) visit(join(dir, d.name), rel ? `${rel}/${d.name}` : d.name);
      } else if (d.isFile()) {
        out.push(rel ? `${rel}/${d.name}` : d.name);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

export function scanDir(root: string, name = 'workspace'): SchemaModel {
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
    now: new Date(0),
    stats: { filesFound: candidates.length, filesRead, filesParsed, durationMs: 0, truncated: false },
  });
}

/** Compact, diff-friendly text snapshot: entities, relations, engines and the warning count. */
export function summarize(model: SchemaModel): string {
  const lines: string[] = [];
  lines.push(`entities: ${model.entities.length}`);
  for (const e of [...model.entities].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`  ${e.id} [${e.kind}]: ${e.columns.map((c) => c.name).join(', ')}`);
  }
  lines.push(`relations: ${model.relations.length}`);
  const rels = model.relations.map(
    (r) => `  ${r.from}(${r.fromColumns.join(',')}) -> ${r.to}(${r.toColumns.join(',')}) ${r.kind} ${r.cardinality}`,
  );
  lines.push(...rels.sort());
  lines.push(`engines: ${model.engines.map((e) => e.id).sort().join(', ')}`);
  lines.push(`warnings: ${model.warnings.length}`);
  return lines.join('\n') + '\n';
}

// CLI: `tsx`-free usage through vitest only; this file is imported by the e2e test.
