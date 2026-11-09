import { describe, expect, it } from 'vitest';
import { isUncertain, provenanceSummary, provenanceTextLines } from '../../src/core/format';
import type { Column, FileResult, ParseResult, RawEntity, RawRelation, SourceKind } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { resolveSchema } from '../../src/core/resolve';

const src = (file: string, line = 0) => ({ file, line });
const pk = () => column('id', 'int', { primaryKey: true, nullable: false });
const col = (name: string, type = 'int', props: Partial<Column> = {}) => column(name, type, props);

function table(file: string, name: string, columns: Column[], extra: Partial<RawEntity> = {}, line = 0): RawEntity {
  return { name, kind: 'table', columns, source: src(file, line), ...extra };
}

function fk(file: string, from: string, fromColumns: string[], to: string, extra: Partial<RawRelation> = {}, line = 0): RawRelation {
  return { from: { name: from }, fromColumns, to: { name: to }, toColumns: [], cardinality: 'many-to-one', kind: 'foreign-key', source: src(file, line), ...extra };
}

function result(path: string, kind: SourceKind, r: Partial<ParseResult>): FileResult {
  return { file: path, kind, result: { entities: [], relations: [], enums: [], ...r } };
}

describe('provenance', () => {
  it('marks declared entities and foreign keys as high confidence with their source lines', () => {
    const f = 'schema.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [table(f, 'users', [pk()], {}, 1), table(f, 'posts', [pk(), col('user_id')], {}, 5)],
        relations: [fk(f, 'posts', ['user_id'], 'users', {}, 7)],
      }),
    ]);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.provenance).toMatchObject({ derivation: 'declared', confidence: 'high', refs: [{ file: f, line: 1 }] });
    expect(users.provenance?.merged).toBeUndefined();
    const rel = r.relations[0];
    expect(rel.provenance).toMatchObject({ derivation: 'declared', confidence: 'high', refs: [{ file: f, line: 7 }] });
    expect(isUncertain(rel.provenance)).toBe(false);
  });

  it('marks relations guessed from column naming as inferred, low confidence', () => {
    const f = 'schema.sql';
    const r = resolveSchema([
      result(f, 'sql', { entities: [table(f, 'users', [pk()]), table(f, 'posts', [pk(), col('user_id')], {}, 4)] }),
    ]);
    const rel = r.relations[0];
    expect(rel.kind).toBe('inferred');
    expect(rel.provenance).toMatchObject({ derivation: 'inferred', confidence: 'low' });
    expect(isUncertain(rel.provenance)).toBe(true);
    expect(provenanceSummary(rel.provenance!)).toBe('Inferred from naming · low confidence');
  });

  it('flags table names derived from the model name and merged contributions', () => {
    const r = resolveSchema([
      result('models/user.ts', 'typeorm', {
        entities: [table('models/user.ts', 'users', [pk()], { modelName: 'User', nameCertainty: 0 }, 3)],
      }),
      result('db/schema.sql', 'sql', { entities: [table('db/schema.sql', 'accounts', [pk()], {}, 9)] }),
    ]);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.provenance).toMatchObject({ derivation: 'guessed', confidence: 'medium' });
    expect(users.provenance?.notes.join(' ')).toContain('"User"');
    expect(isUncertain(users.provenance)).toBe(true);

    const merged = resolveSchema([
      result('a.sql', 'sql', { entities: [table('a.sql', 't', [pk()], {}, 1)] }),
      result('b.sql', 'sql', { entities: [table('b.sql', 't', [col('x')], { partial: true }, 2)] }),
    ]);
    const t = merged.entities[0].provenance!;
    expect(t.merged).toBe(true);
    expect(t.refs).toEqual([
      { file: 'a.sql', line: 1 },
      { file: 'b.sql', line: 2 },
    ]);
  });

  it('marks external placeholders and ORM associations merged with a foreign key', () => {
    const f = 'schema.prisma';
    const r = resolveSchema([
      result(f, 'prisma', {
        entities: [table(f, 'posts', [pk(), col('author_id')])],
        relations: [fk(f, 'posts', ['author_id'], 'auth_users', { kind: 'orm' }, 3)],
      }),
      result('x.sql', 'sql', { relations: [fk('x.sql', 'posts', ['author_id'], 'auth_users', {}, 8)] }),
    ]);
    const ext = r.entities.find((e) => e.id === 'auth_users')!;
    expect(ext.provenance).toMatchObject({ derivation: 'external', confidence: 'low' });
    const rel = r.relations[0];
    expect(rel.provenance?.confidence).toBe('low');
    expect(rel.provenance?.notes.join(' ')).toContain('not defined in the workspace');
    expect(rel.provenance?.refs.map((x) => x.file).sort()).toEqual(['schema.prisma', 'x.sql']);
    expect(rel.provenance?.merged).toBe(true);
  });

  it('marks foreign key columns implied by an ORM association', () => {
    const f = 'models.ts';
    const r = resolveSchema([
      result(f, 'sequelize', {
        entities: [table(f, 'users', [pk()], { modelName: 'User' }), table(f, 'posts', [pk()], { modelName: 'Post' }, 4)],
        relations: [fk(f, 'posts', ['user_id'], 'users', { kind: 'orm' }, 6)],
      }),
    ]);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    const implied = posts.columns.find((c) => c.name === 'user_id')!;
    expect(implied.provenance).toMatchObject({ derivation: 'implied', refs: [{ file: f, line: 6 }] });
    expect(posts.columns.find((c) => c.name === 'id')!.provenance).toBeUndefined();
  });

  it('formats text lines with at most five source locations', () => {
    const refs = Array.from({ length: 7 }, (_, i) => ({ file: 'f.sql', line: i }));
    const lines = provenanceTextLines({ derivation: 'declared', confidence: 'high', refs, notes: ['n1'] });
    expect(lines[0]).toBe('Declared · high confidence');
    expect(lines[1]).toBe('n1');
    expect(lines[2]).toBe('From f.sql:1, f.sql:2, f.sql:3, f.sql:4, f.sql:5, +2 more');
  });

  it('tolerates models without provenance (saved by older versions)', () => {
    expect(isUncertain(undefined)).toBe(false);
  });
});
