/**
 * Validates toMermaid output for nasty names with the REAL mermaid parser (under jsdom).
 * mermaid is not a project dependency: install it in `.tmp` (`cd .tmp; npm i mermaid@11.17.2 jsdom`);
 * without it this suite is skipped.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Entity, Relation } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { toMermaid } from '../../src/core/export';

const tmp = join(process.cwd(), '.tmp');
const available = existsSync(join(tmp, 'node_modules', 'mermaid')) && existsSync(join(tmp, 'node_modules', 'jsdom'));

const NASTY = [
  'a b', 'end', 'Style', 'CLASS', 'x"y', 'a\\b', '1abc', 'päivä', 'a%b', 'a;b', 'a:b', 'a{b}', 'a|b', 'a--b', '--',
  'a]b', '`x`', '<b>', 'a\nb', '', ' ', 'a.b', 'a,b', 'a#b', 'a/b', 'a(b)', '日本語', "a'b", '_x', '-x', 'x-', 'a&b',
  'a=b', '$x', '@x', '[x]', 'a*b', 'a~b', 'a!b', 'PK', 'title', 'one', 'a\u0000b', 'a\u2028b', '😀', 'a b c d',
];

function ent(id: string, name: string, cols: string[], extra: Partial<Entity> = {}): Entity {
  return {
    id, name, kind: 'table', modelNames: [],
    columns: cols.map((c) => column(c, c.length % 2 ? 'varchar(10)' : 'List<int>', { comment: `c "${c}"\n--` })),
    indexes: [], sources: ['sql'], files: ['s.sql'], source: { file: 's.sql', line: 0 }, ...extra,
  };
}

describe.skipIf(!available)('Mermaid validity (real parser)', () => {
  it('parses diagrams built from nasty entity, column, schema and relation names', async () => {
    const req = createRequire(join(tmp, 'package.json'));
    const { JSDOM } = req('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const mermaid = (await import(pathToFileURL(req.resolve('mermaid')).href)).default;

    const failures: string[] = [];
    await expect(mermaid.parse('erDiagram\n    end {\n        int id\n    }')).rejects.toBeTruthy(); // parser is really strict
    for (const n of NASTY) {
      const a = ent(`a:${n}`, n, [n, 'id', n + n], { schema: n || undefined });
      const b = ent(`b:${n}`, n, [n]);
      const rel: Relation = {
        id: 'r', from: a.id, fromColumns: [n, 'x"y'], to: b.id, toColumns: ['id'],
        cardinality: 'many-to-one', kind: 'foreign-key', optional: false, sources: ['sql'],
      };
      for (const columns of ['all', 'keys', 'none'] as const) {
        const text = toMermaid({ entities: [a, b], relations: [rel, { ...rel, id: 'r2', kind: 'inferred', cardinality: 'many-to-many', throughName: n }] }, { columns });
        try {
          await mermaid.parse(text);
        } catch (e) {
          failures.push(`${JSON.stringify(n)} [${columns}]: ${String((e as Error).message).split('\n')[0]}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
