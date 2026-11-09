import { describe, expect, it } from 'vitest';
import { diffSchemas, diffSummaryText, diffToMarkdown, isEmptyDiff } from '../../src/core/diff';
import type { Column, Entity, EnumDef, Relation, SchemaModel } from '../../src/core/model';
import { column } from '../../src/core/parser';

function entity(id: string, columns: Column[], extra: Partial<Entity> = {}): Entity {
  return { id, name: extra.name ?? id, kind: 'table', modelNames: [], columns, indexes: [], sources: ['sql'], files: ['s.sql'], ...extra };
}

function relation(from: string, fromColumns: string[], to: string, extra: Partial<Relation> = {}): Relation {
  return { id: `${from}>${to}`, from, fromColumns, to, toColumns: ['id'], cardinality: 'many-to-one', kind: 'foreign-key', optional: false, sources: ['sql'], ...extra };
}

function model(entities: Entity[], relations: Relation[] = [], enums: EnumDef[] = []): SchemaModel {
  return {
    version: 1,
    generatedAt: '2024-01-01T00:00:00.000Z',
    workspaceName: 'w',
    entities,
    relations,
    enums,
    engines: [],
    sources: [],
    warnings: [],
    stats: { filesFound: 0, filesRead: 0, filesParsed: 0, durationMs: 0, truncated: false },
  };
}

const id = column('id', 'int', { primaryKey: true, nullable: false });
const users = () => entity('users', [id, column('email', 'varchar(255)')]);

describe('diffSchemas', () => {
  it('reports no changes for identical models', () => {
    const d = diffSchemas(model([users()]), model([users()]));
    expect(isEmptyDiff(d)).toBe(true);
    expect(diffSummaryText(d)).toBe('No schema changes');
  });

  it('detects added and removed entities with all their columns', () => {
    const d = diffSchemas(model([users(), entity('old', [id])]), model([users(), entity('posts', [id, column('title', 'text')])]));
    expect(d.entities.map((e) => [e.name, e.kind])).toEqual([['posts', 'added'], ['old', 'removed']]);
    expect(d.entities[0].columns.map((c) => c.kind)).toEqual(['added', 'added']);
    expect(d.entities[1].columns.map((c) => c.kind)).toEqual(['removed']);
    expect(d.summary.entities).toEqual({ added: 1, removed: 1, changed: 0 });
    expect(d.summary.columns).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('detects added, removed and changed columns', () => {
    const before = model([entity('users', [id, column('email', 'varchar(100)'), column('legacy', 'int')])]);
    const after = model([entity('users', [id, column('email', 'varchar(255)', { nullable: false, unique: true }), column('age', 'int')])]);
    const d = diffSchemas(before, after);
    expect(d.entities).toHaveLength(1);
    const e = d.entities[0];
    expect(e.kind).toBe('changed');
    expect(e.unchangedColumns).toBe(1);
    const by = Object.fromEntries(e.columns.map((c) => [c.name, c]));
    expect(by.age.kind).toBe('added');
    expect(by.legacy.kind).toBe('removed');
    expect(by.email.kind).toBe('changed');
    expect(by.email.changes).toEqual(['type: varchar(100) -> varchar(255)', 'now NOT NULL', 'now unique']);
    expect(d.summary.columns).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(d.summary.total).toBe(4); // 1 changed table + 3 column changes
  });

  it('compares types and column names case-insensitively', () => {
    const d = diffSchemas(model([entity('t', [column('Name', 'TEXT')])]), model([entity('t', [column('name', 'text')])]));
    expect(isEmptyDiff(d)).toBe(true);
  });

  it('detects primary key, generated, array, default and comment changes', () => {
    const before = model([entity('t', [column('a', 'int', { default: '1', comment: 'x' })])]);
    const after = model([entity('t', [column('a', 'int', { primaryKey: true, generated: true, isArray: true, default: '2', comment: 'y' })])]);
    const changes = diffSchemas(before, after).entities[0].columns[0].changes;
    expect(changes).toEqual(['now primary key', 'now generated', 'now an array', 'default: 1 -> 2', 'comment changed']);
  });

  it('detects index changes, ignoring index names', () => {
    const before = model([entity('t', [id], { indexes: [{ name: 'a', columns: ['x'], unique: false }, { columns: ['y'], unique: false }] })]);
    const after = model([entity('t', [id], { indexes: [{ name: 'renamed', columns: ['x'], unique: false }, { columns: ['x', 'z'], unique: true }] })]);
    const e = diffSchemas(before, after).entities[0];
    expect(e.indexesAdded).toEqual(['unique (x, z)']);
    expect(e.indexesRemoved).toEqual(['(y)']);
    expect(e.columns).toEqual([]);
  });

  it('detects entity kind changes', () => {
    const d = diffSchemas(model([entity('v', [id])]), model([entity('v', [id], { kind: 'view' })]));
    expect(d.entities[0].kindChange).toBe('table -> view');
  });

  it('uses schema-qualified names for display', () => {
    const d = diffSchemas(model([]), model([entity('auth.users', [id], { name: 'users', schema: 'auth' })]));
    expect(d.entities[0].name).toBe('auth.users');
  });

  it('detects relation changes', () => {
    const base = model(
      [users(), entity('posts', [id, column('user_id', 'int')]), entity('tags', [id])],
      [relation('posts', ['user_id'], 'users', { onDelete: 'CASCADE' }), relation('posts', ['tag_id'], 'tags')],
    );
    const head = model(
      [users(), entity('posts', [id, column('user_id', 'int')]), entity('tags', [id]), entity('comments', [id, column('post_id', 'int')])],
      [relation('posts', ['user_id'], 'users', { onDelete: 'SET NULL' }), relation('comments', ['post_id'], 'posts')],
    );
    const d = diffSchemas(base, head);
    expect(d.relations.map((r) => [r.kind, r.label])).toEqual([
      ['added', 'comments(post_id) -> posts(id)'],
      ['changed', 'posts(user_id) -> users(id)'],
      ['removed', 'posts(tag_id) -> tags(id)'],
    ]);
    expect(d.relations[1].changes).toEqual(['on delete: CASCADE -> SET NULL']);
    expect(d.summary.relations).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('matches relations regardless of foreign key column order and ignores unrelated ids', () => {
    const a = model([users()], [relation('a', ['y', 'x'], 'users', { id: 'one' })]);
    const b = model([users()], [relation('a', ['x', 'y'], 'users', { id: 'two' })]);
    expect(diffSchemas(a, b).relations).toEqual([]);
  });

  it('detects relation cardinality / optionality changes', () => {
    const a = model([], [relation('a', ['x'], 'b')]);
    const b = model([], [relation('a', ['x'], 'b', { cardinality: 'one-to-one', optional: true })]);
    expect(diffSchemas(a, b).relations[0].changes).toEqual(['cardinality: many-to-one -> one-to-one', 'now optional']);
  });

  it('detects enum changes', () => {
    const en = (idv: string, values: string[]): EnumDef => ({ id: idv, name: idv, values, sources: ['sql'] });
    const d = diffSchemas(model([], [], [en('role', ['a', 'b']), en('gone', ['x'])]), model([], [], [en('role', ['b', 'c']), en('fresh', ['y'])]));
    expect(d.enums.map((e) => [e.name, e.kind])).toEqual([['fresh', 'added'], ['role', 'changed'], ['gone', 'removed']]);
    expect(d.enums[1].valuesAdded).toEqual(['c']);
    expect(d.enums[1].valuesRemoved).toEqual(['a']);
  });

  it('summarises counts in text', () => {
    const d = diffSchemas(model([users()]), model([users(), entity('posts', [id])]));
    expect(diffSummaryText(d)).toBe('1 table added');
    const d2 = diffSchemas(model([entity('a', [id])]), model([entity('a', [id, column('b')]), entity('c', [id]), entity('d', [id])]));
    expect(diffSummaryText(d2)).toBe('2 tables added, 1 table changed, 1 column added');
  });

  it('handles empty models on either side', () => {
    expect(isEmptyDiff(diffSchemas(model([]), model([])))).toBe(true);
    expect(diffSchemas(model([]), model([users()])).summary.entities.added).toBe(1);
    expect(diffSchemas(model([users()]), model([])).summary.entities.removed).toBe(1);
  });
});

describe('diffToMarkdown', () => {
  it('renders an empty changelog', () => {
    expect(diffToMarkdown(diffSchemas(model([]), model([])), { base: 'main', head: 'Working tree' })).toBe(
      '# Schema changes: main -> Working tree\n\n**No schema changes**\n',
    );
  });

  it('renders added, changed and removed sections', () => {
    const base = model(
      [entity('users', [id, column('email', 'varchar(100)')]), entity('old', [id])],
      [relation('users', ['org_id'], 'orgs')],
      [{ id: 'role', name: 'role', values: ['a'], sources: ['sql'] }],
    );
    const head = model(
      [entity('users', [id, column('email', 'varchar(255)')]), entity('posts', [id, column('title', 'text')])],
      [],
      [{ id: 'role', name: 'role', values: ['a', 'b'], sources: ['sql'] }],
    );
    const md = diffToMarkdown(diffSchemas(base, head), { base: 'v1.0', head: 'HEAD' });
    expect(md).toContain('# Schema changes: v1.0 -> HEAD');
    expect(md).toContain('## Added');
    expect(md).toContain('#### posts');
    expect(md).toContain('- + `title` `text`');
    expect(md).toContain('## Changed');
    expect(md).toContain('- ~ `email`: type: varchar(100) -> varchar(255)');
    expect(md).toContain('- `role`: + b');
    expect(md).toContain('## Removed');
    expect(md).toContain('#### old');
    expect(md).toContain('- - `id` `int`');
    expect(md).toContain('- users(org_id) -> orgs(id) (many-to-one)');
    expect(md.indexOf('## Added')).toBeLessThan(md.indexOf('## Changed'));
    expect(md.indexOf('## Changed')).toBeLessThan(md.indexOf('## Removed'));
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });
});
