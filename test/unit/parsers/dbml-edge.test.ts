import { describe, expect, it } from 'vitest';
import { dbmlParser } from '../../../src/parsers/dbml';

// Edge-case coverage for the DBML parser (quoting, multi-line notes/enums, every ref operator,
// composite / self / schema-qualified relations, CRLF equivalence, malformed input).
const parse = (text: string) => dbmlParser.parse({ path: 'schema.dbml', text });

describe('dbml — enums', () => {
  it('reads a multi-line enum with quoted, spaced values and per-value notes', () => {
    const text = ['Enum job_status {', '  created', '  running', '  "on hold" [note: "paused"]', '}'].join('\n');
    const e = parse(text).enums.find((x) => x.name === 'job_status');
    expect(e?.values).toEqual(['created', 'running', 'on hold']);
  });
});

describe('dbml — relation operators & shapes', () => {
  it('maps >, <, - and <> to the right direction and cardinality', () => {
    const text = [
      'Table a { id int [pk] }',
      'Table b { id int [pk] }',
      'Ref: b.a_id > a.id', // many-to-one, from = b
      'Ref: a.id < b.a_id2', // many-to-one, from = b (flipped)
      'Ref: a.id - b.id', // one-to-one
      'Ref: a.id <> b.id', // many-to-many
    ].join('\n');
    const rels = parse(text).relations;
    expect(rels.map((r) => `${r.from.name}->${r.to.name}:${r.cardinality}`)).toEqual([
      'b->a:many-to-one',
      'b->a:many-to-one',
      'a->b:one-to-one',
      'a->b:many-to-many',
    ]);
  });

  it('reads inline column refs, composite refs, self references and schema qualification', () => {
    const text = [
      'Table core.posts {',
      '  id int [pk]',
      '  author_id int [ref: > core.users.id]',
      '  parent_id int',
      '}',
      'Table core.users { id int [pk] }',
      'Ref: core.posts.(a, b) > core.users.(x, y)',
      'Ref: core.posts.parent_id > core.posts.id',
    ].join('\n');
    const rels = parse(text).relations;
    const inline = rels.find((r) => r.fromColumns.join() === 'author_id');
    expect(inline).toMatchObject({ from: { name: 'posts', schema: 'core' }, to: { name: 'users', schema: 'core' } });
    const composite = rels.find((r) => r.fromColumns.join() === 'a,b');
    expect(composite?.toColumns).toEqual(['x', 'y']);
    const self = rels.find((r) => r.fromColumns.join() === 'parent_id');
    expect(self).toMatchObject({ from: { name: 'posts' }, to: { name: 'posts' } });
  });

  it('resolves a table alias used on a ref endpoint', () => {
    const text = ['Table users as U { id int [pk] }', 'Table posts { id int [pk]\n author_id int }', 'Ref: posts.author_id > U.id'].join('\n');
    const rel = parse(text).relations[0];
    expect(rel.to.name).toBe('users');
  });
});

describe('dbml — columns & tables', () => {
  it('reads pk/increment/not null/default and a triple-quoted table note', () => {
    const text = [
      'Table users {',
      '  id int [pk, increment]',
      '  email varchar [not null, unique]',
      '  created_at timestamp [default: `now()`]',
      "  Note: '''Primary users table'''",
      '}',
    ].join('\n');
    const t = parse(text).entities.find((e) => e.name === 'users');
    expect(t?.comment).toBe('Primary users table');
    expect(t?.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, nullable: false, generated: true });
    expect(t?.columns.find((c) => c.name === 'email')).toMatchObject({ nullable: false, unique: true });
    expect(t?.columns.find((c) => c.name === 'created_at')?.default).toBe('now()');
  });

  it('reads the Project database_type as an engine hint', () => {
    const r = parse('Project p { database_type: "PostgreSQL" }\nTable t { id int [pk] }');
    expect(r.engines?.map((e) => e.engine)).toEqual(['postgresql']);
  });
});

describe('dbml — robustness', () => {
  it('never throws on truncated / malformed input', () => {
    for (const bad of ['Table t {', 'Table t { id int [', 'Ref: a.b >', 'Enum e {', 'Table { }', 'Ref:', 'Project {']) {
      expect(() => parse(bad)).not.toThrow();
    }
  });

  it('CRLF line endings produce the identical result to LF', () => {
    const lf = [
      'Enum status { active inactive }',
      'Table users {',
      '  id int [pk]',
      '  status status',
      '  Note: "users"',
      '}',
      'Table posts { id int [pk]\n user_id int [ref: > users.id] }',
    ].join('\n');
    expect(JSON.stringify(parse(lf))).toBe(JSON.stringify(parse(lf.replace(/\n/g, '\r\n'))));
  });
});
