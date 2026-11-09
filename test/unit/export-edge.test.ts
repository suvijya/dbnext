import { describe, expect, it } from 'vitest';
import type { Entity, Relation, SchemaModel } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { toMarkdown } from '../../src/core/export';

function entity(id: string, name: string, extra: Partial<Entity> = {}): Entity {
  return {
    id, name, kind: 'table', modelNames: [], columns: [column('id', 'int', { primaryKey: true })],
    indexes: [], sources: ['sql'], files: ['a.sql'], source: { file: 'a.sql', line: 4 }, ...extra,
  };
}

function model(entities: Entity[], relations: Relation[] = []): SchemaModel {
  return {
    version: 1, generatedAt: '2026-09-30T10:00:00.000Z', workspaceName: 'w', entities, relations, enums: [], engines: [],
    sources: [], warnings: [], stats: { filesFound: 1, filesRead: 1, filesParsed: 1, durationMs: 1, truncated: false },
  };
}

describe('markdown escaping of nasty names', () => {
  const nasty = entity('n', 'my_table*[x](y)\n# h');
  const other = entity('o', 'other`tick');
  const rel: Relation = {
    id: 'r', from: 'n', fromColumns: ['id'], to: 'o', toColumns: ['id'], cardinality: 'many-to-one',
    kind: 'foreign-key', optional: false, sources: ['sql'],
  };
  const md = toMarkdown(model([nasty, other], [rel]));

  it('keeps headings on a single line with inline syntax escaped', () => {
    expect(md).toContain('### my\\_table\\*\\[x\\](y) \\# h');
    expect(md).not.toMatch(/^# h$/m);
  });

  it('escapes link labels while the anchor stays the GitHub slug of the plain text', () => {
    expect(md).toContain('[my\\_table\\*\\[x\\](y) \\# h](#my_tablexy--h)');
    expect(md).toContain('[other\\`tick](#othertick)');
  });

  it('percent-encodes spaces, # ? ( ) and % in file links but keeps the #L anchor', () => {
    const e = entity('e', 'e');
    const out = toMarkdown(model([e]), { fileLink: (ref) => `../we ird#1/a(b)?c%d/${ref.file}#L${ref.line + 1}` });
    expect(out).toContain('(../we%20ird%231/a%28b%29%3Fc%25d/a.sql#L5)');
  });
});
