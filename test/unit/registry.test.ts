import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SOURCE_KINDS } from '../../src/core/model';
import { globToRegExp, includePatterns, priorityPatterns } from '../../src/core/scan';
import { parsers, registry } from '../../src/parsers';

describe('parser registry', () => {
  it('has exactly one parser per source kind', () => {
    const kinds = parsers.map((p) => p.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual([...SOURCE_KINDS].sort());
  });

  it('declares lower-case dotted extensions and callable detect/parse', () => {
    for (const p of parsers) {
      expect(p.extensions.length, p.kind).toBeGreaterThan(0);
      for (const e of p.extensions) expect(e, p.kind).toMatch(/^\.[a-z0-9]+$/);
      expect(typeof p.detect).toBe('function');
      expect(typeof p.parse).toBe('function');
    }
  });

  it('keeps the dbnext.disabledSources setting in sync with the parsers', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const values: string[] = pkg.contributes.configuration.properties['dbnext.disabledSources'].items.enum;
    expect([...values].sort()).toEqual(parsers.map((p) => p.kind).sort());
  });

  it('builds include/priority globs that cover typical schema files and never real .env files', () => {
    const include = globToRegExp(includePatterns(registry));
    const priority = globToRegExp(priorityPatterns(registry));
    for (const p of [
      'prisma/schema.prisma',
      'db/schema.rb',
      'app/models/user.rb',
      'blog/models.py',
      'src/entities/user.entity.ts',
      'src/db/schema.ts',
      'migrations/001_init.sql',
      'src/main/resources/db/changelog/db.changelog-master.yaml',
      'Data/AppDbContext.cs',
      'docker-compose.yml',
      'package.json',
    ]) {
      expect(include.test(p), p).toBe(true);
    }
    for (const p of ['prisma/schema.prisma', 'db/schema.rb', 'blog/models.py', 'migrations/001_init.sql', 'docker-compose.yml']) {
      expect(priority.test(p), p).toBe(true);
    }
    expect(include.test('pom-backup.xml')).toBe(false); // XML only via Liquibase filePatterns / pom.xml
    expect(registry.engines.matches('.env')).toBe(false);
    expect(registry.engines.matches('config/.env')).toBe(false);
    expect(registry.engines.matches('.env.example')).toBe(true);
  });

  it('parsers never throw on hostile or binary-looking input', () => {
    const inputs = [
      '',
      '\u0000\u0001\u0002',
      '{'.repeat(5000),
      ')'.repeat(5000),
      '"'.repeat(3001),
      "'''".repeat(1000),
      '/*'.repeat(2000),
      'CREATE TABLE ('.repeat(500),
      '@Entity class @Column(('.repeat(500),
      'model { @relation(fields: [', 
      'class X(models.Model):\n    a = models.ForeignKey(',
      'create_table :x do |t|\n t.references',
    ];
    for (const p of parsers) {
      for (const ext of p.extensions) {
        for (const text of inputs) {
          const file = { path: `src/models/x${ext}`, text };
          expect(() => p.detect(file), `${p.kind} detect`).not.toThrow();
          expect(() => p.parse(file), `${p.kind} parse ${ext}`).not.toThrow();
        }
      }
    }
  });
});
