import { describe, expect, it } from 'vitest';
import { stripVolatile } from '../../src/core/export';
import { emptyResult, type SourceFile } from '../../src/core/model';
import type { SchemaParser } from '../../src/core/parser';
import { sanitizeLayout } from '../../src/core/protocol';
import {
  DEFAULT_EXCLUDES,
  decodeText,
  expandBraces,
  globGroup,
  globToRegExp,
  includePatterns,
  parseFile,
  pathPriority,
  priorityPatterns,
  relativePath,
  sanitizeExportPath,
  type ParserRegistry,
} from '../../src/core/scan';

function parser(kind: SchemaParser['kind'], extensions: string[], impl: Partial<SchemaParser> = {}): SchemaParser {
  return {
    kind,
    extensions,
    detect: () => true,
    parse: (f: SourceFile) => ({ ...emptyResult(), entities: [{ name: f.path, kind: 'table', columns: [], source: { file: f.path, line: 0 } }] }),
    ...impl,
  };
}

const noEngines: ParserRegistry['engines'] = { filePatterns: [], matches: () => false, detect: () => [] };

describe('globs', () => {
  it('expands brace groups, including nested and escaped braces', () => {
    expect(expandBraces('**/*.{ts,js}')).toEqual(['**/*.ts', '**/*.js']);
    expect(expandBraces('a{b,c{d,e}}f')).toEqual(['abf', 'acdf', 'acef']);
    expect(expandBraces('{x,y}/{1,2}')).toEqual(['x/1', 'x/2', 'y/1', 'y/2']);
    expect(expandBraces('plain/**')).toEqual(['plain/**']);
    expect(expandBraces('a\\{b,c}')).toEqual(['a\\{b,c}']);
  });

  it('combines patterns into one flat brace group', () => {
    expect(globGroup(['**/*.{ts,js}', '**/*.ts', ' **/a.sql '])).toBe('{**/*.ts,**/*.js,**/a.sql}');
    expect(globGroup(['**/*.sql'])).toBe('**/*.sql');
    expect(globGroup([])).toBe('');
  });

  it('matches relative paths like VS Code globs (case-insensitive)', () => {
    const nm = globToRegExp('**/node_modules/**');
    expect(nm.test('node_modules/x/y.js')).toBe(true);
    expect(nm.test('a/node_modules/b.js')).toBe(true);
    expect(nm.test('node_modules_x/a.js')).toBe(false);
    const sql = globToRegExp(['**/*.sql', '**/*.{ts,js}']);
    expect(sql.test('a.sql')).toBe(true);
    expect(sql.test('db/Schema.SQL')).toBe(true);
    expect(sql.test('src/x.js')).toBe(true);
    expect(sql.test('src/x.jsx')).toBe(false);
    expect(globToRegExp('db/v?.sql').test('db/v1.sql')).toBe(true);
    expect(globToRegExp('db/[ab].sql').test('db/b.sql')).toBe(true);
    expect(globToRegExp('db/[!ab].sql').test('db/b.sql')).toBe(false);
    expect(globToRegExp([]).test('anything')).toBe(false);
  });

  it('default excludes skip dependencies, tests and down migrations but keep schema files', () => {
    const excluded = globToRegExp(DEFAULT_EXCLUDES);
    for (const p of ['node_modules/prisma/x.prisma', 'src/__tests__/user.ts', 'app/models/user.test.ts', 'db/migrations/1_init.down.sql', 'migrations/2024_x/down.sql', 'vendor/laravel/x.php', 'Migrations/20240101_Init.Designer.cs', 'dist/extension.js', 'spec/dummy/db/schema.rb', 'tests/models.py', 'packages/api/test/schema.sql']) {
      expect(excluded.test(p), p).toBe(true);
    }
    for (const p of ['prisma/schema.prisma', 'db/migrations/1_init.up.sql', 'migrations/2024_x/up.sql', 'app/models/user.rb', 'src/db/schema.ts', 'Data/AppDbContext.cs']) {
      expect(excluded.test(p), p).toBe(false);
    }
  });
});

describe('prioritisation', () => {
  it('ranks likely schema files first and test/example folders last', () => {
    expect(pathPriority('prisma/schema.prisma')).toBeGreaterThan(pathPriority('src/utils/helpers.ts'));
    expect(pathPriority('db/schema.sql')).toBeGreaterThan(pathPriority('examples/db/schema.sql'));
    expect(pathPriority('src/entities/user.entity.ts')).toBeGreaterThan(pathPriority('src/app.ts'));
    expect(pathPriority('src/app.ts')).toBe(0);
  });

  it('builds include and priority patterns from the registered parsers', () => {
    const registry: ParserRegistry = {
      parsers: [parser('prisma', ['.prisma']), parser('typeorm', ['.ts', '.js'])],
      engines: { ...noEngines, filePatterns: ['**/docker-compose*.yml'] },
    };
    expect(includePatterns(registry)).toEqual(['**/*.js', '**/*.prisma', '**/*.ts', '**/docker-compose*.yml']);
    const prio = priorityPatterns(registry);
    expect(prio).toContain('**/*.prisma');
    expect(prio).toContain('**/*.{entity,model,schema}.{ts,js,mts,cts,mjs,cjs}');
    expect(prio).not.toContain('**/*.sql'); // no SQL parser registered
    expect(prio.some((p) => p.startsWith('**/{models,Models,'))).toBe(true);
    expect(prio[prio.length - 1]).toBe('**/docker-compose*.yml');
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 (with or without BOM) and UTF-16, rejects binary', () => {
    const enc = new TextEncoder();
    expect(decodeText(enc.encode('CREATE TABLE ü (a int);'))).toBe('CREATE TABLE ü (a int);');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('x')]))).toBe('x');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]))).toBe('ab');
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBeUndefined();
  });
});

describe('parseFile', () => {
  it('runs matching, enabled parsers and the engine detector; captures crashes', () => {
    const calls: string[] = [];
    const registry: ParserRegistry = {
      parsers: [
        parser('sql', ['.sql']),
        parser('prisma', ['.prisma'], { parse: () => (calls.push('prisma'), emptyResult()) }),
        parser('dbml', ['.sql'], { detect: () => false }),
        parser('knex', ['.sql'], { parse: () => { throw new Error('boom'); } }),
        parser('kysely', ['.sql']),
      ],
      engines: { filePatterns: [], matches: (p) => p.endsWith('.sql'), detect: () => [{ engine: 'postgresql', line: 0, detail: 'test' }] },
    };
    const out = parseFile({ path: 'db/schema.sql', text: 'x' }, registry, new Set(['kysely']));
    expect(out.results.map((r) => r.kind)).toEqual(['sql']);
    expect(out.results[0].file).toBe('db/schema.sql');
    expect(out.errors).toEqual(['knex parser failed: boom']);
    expect(out.hints).toEqual([{ engine: 'postgresql', line: 0, detail: 'test' }]);
    expect(calls).toEqual([]);
  });

  it('drops empty results', () => {
    const registry: ParserRegistry = { parsers: [parser('sql', ['.sql'], { parse: () => emptyResult() })], engines: noEngines };
    expect(parseFile({ path: 'a.sql', text: '' }, registry).results).toEqual([]);
  });

  it('honours parser filePatterns in discovery and parsing', () => {
    const registry: ParserRegistry = {
      parsers: [parser('liquibase', ['.xml', '.yaml'], { filePatterns: ['**/*changelog*.{xml,yaml}'] }), parser('sql', ['.sql'])],
      engines: noEngines,
    };
    expect(includePatterns(registry)).toEqual(['**/*.sql', '**/*changelog*.{xml,yaml}']);
    expect(priorityPatterns(registry)).toContain('**/*changelog*.{xml,yaml}');
    expect(parseFile({ path: 'src/main/resources/db/changelog/db.changelog-master.xml', text: '' }, registry).results).toHaveLength(1);
    expect(parseFile({ path: 'pom.xml', text: '' }, registry).results).toEqual([]);
  });
});

describe('paths and sanitizers', () => {
  it('computes relative links between URI paths', () => {
    expect(relativePath('/c:/repo', '/c:/repo/db/schema.sql')).toBe('db/schema.sql');
    expect(relativePath('/c:/repo/docs', '/c:/repo/db/schema.sql')).toBe('../db/schema.sql');
    expect(relativePath('/C:/repo/docs', '/c:/repo/docs/a.md', true)).toBe('a.md');
    expect(relativePath('/C:/repo/docs', '/c:/repo/docs/a.md', false)).toBe('../../../c:/repo/docs/a.md');
    expect(relativePath('/home/u/a', '/home/u/a/b/c.sql')).toBe('b/c.sql');
  });

  it('keeps the export path inside the workspace', () => {
    expect(sanitizeExportPath('DBMAP.md')).toBe('DBMAP.md');
    expect(sanitizeExportPath(' docs\\database.md ')).toBe('docs/database.md');
    expect(sanitizeExportPath('./docs/./db')).toBe('docs/db.md');
    for (const bad of ['../outside.md', 'docs/../../x.md', '/etc/x.md', 'C:\\x.md', '', '   ', 42, undefined]) {
      expect(sanitizeExportPath(bad)).toBe('DBMAP.md');
    }
  });

  it('sanitizes layouts received from the webview', () => {
    expect(sanitizeLayout({ users: { x: 1.234, y: -5 }, bad: { x: 'a', y: 1 }, inf: { x: Infinity, y: 0 }, nul: null })).toEqual({ users: { x: 1.2, y: -5 } });
    expect(sanitizeLayout([1, 2])).toBeUndefined();
    expect(sanitizeLayout('x')).toBeUndefined();
  });

  it('ignores volatile lines when comparing Markdown exports', () => {
    const a = '# Database map: x\r\n\r\n> Generated by DBNext on 2026-01-01 10:00 UTC …\r\n\r\nbody\r\n\r\n_Scanned 10 files in 1.0 s._\r\n';
    const b = '# Database map: x\n\n> Generated by DBNext on 2026-02-02 11:11 UTC …\n\nbody\n\n_Scanned 12 files in 3.4 s._\n';
    expect(stripVolatile(a)).toBe(stripVolatile(b));
    expect(stripVolatile(a)).not.toBe(stripVolatile(b.replace('body', 'changed')));
  });
});
