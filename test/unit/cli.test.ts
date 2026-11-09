import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('dbnext CLI', () => {
  let dir: string;
  let cli: string;
  let project: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbnext-cli-'));
    cli = join(dir, 'cli.js');
    buildSync({ entryPoints: ['src/cli/cli.ts'], outfile: cli, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    project = join(dir, 'proj');
    writeFileSync(join(dir, 'x'), '');
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(project)})`]);
    writeFileSync(join(project, 'schema.sql'), 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]): string => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('prints each format to stdout', () => {
    expect(run('scan', project)).toContain('erDiagram');
    expect(run('scan', project, '--format', 'dbml')).toContain('Table a');
    expect(run('scan', project, '-f', 'plantuml')).toContain('@startuml');
    expect(JSON.parse(run('scan', project, '--format=json')).entities).toHaveLength(2);
    expect(run('scan', project, '--format', 'mermaid')).toMatch(/^erDiagram/);
  });

  it('writes --out and rejects bad input', () => {
    const out = join(dir, 'sub', 'DBMAP.md');
    run('scan', project, '--out', out);
    expect(readFileSync(out, 'utf8')).toContain('erDiagram');
    expect(() => run('scan', project, '--format', 'nope')).toThrow();
    expect(() => run('scan', join(dir, 'missing'))).toThrow();
  });
});
