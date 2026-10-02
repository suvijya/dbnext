import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { dbmlParser } from '../../../src/parsers/dbml';

const parse = (text: string, path = 'schema.dbml') => dbmlParser.parse({ path, text });
const fr = (text: string, path = 'schema.dbml'): FileResult => ({ file: path, kind: 'dbml', result: parse(text, path) });

describe('dbml detect', () => {
  it('recognises DBML files and rejects unrelated ones', () => {
    expect(dbmlParser.detect({ path: 'a.dbml', text: 'Table users { id int [pk] }' })).toBe(true);
    expect(dbmlParser.detect({ path: 'a.dbml', text: 'Enum role { admin user }' })).toBe(true);
    expect(dbmlParser.detect({ path: 'a.dbml', text: 'Ref: a.b > c.d' })).toBe(true);
    expect(dbmlParser.detect({ path: 'a.dbml', text: 'just a note file' })).toBe(false);
  });
});

describe('dbml tables and columns', () => {
  const text = `
Project shop {
  database_type: 'PostgreSQL'
  Note: 'Shop schema'
}

Table users as U [headercolor: #3498DB] {
  id integer [primary key, increment]
  username varchar(50) [not null, unique]
  email varchar [not null, note: 'login email']
  role_id integer [ref: > roles.id]
  created_at timestamp [default: \`now()\`]
  Note: 'Application users'
  indexes {
    (username, email) [unique, name: 'idx_login']
    email
  }
}

Table roles {
  id integer [pk]
  name "varchar" [unique]
}
`;

  it('parses table name, columns, types and settings', () => {
    const r = parse(text);
    const users = r.entities.find((e) => e.name === 'users')!;
    expect(users.kind).toBe('table');
    expect(users.nameCertainty).toBe(2);
    expect(users.comment).toBe('Application users');
    const id = users.columns.find((c) => c.name === 'id')!;
    expect(id).toMatchObject({ type: 'integer', primaryKey: true, nullable: false, generated: true });
    const username = users.columns.find((c) => c.name === 'username')!;
    expect(username).toMatchObject({ type: 'varchar(50)', nullable: false, unique: true });
    const email = users.columns.find((c) => c.name === 'email')!;
    expect(email).toMatchObject({ nullable: false, comment: 'login email' });
    const created = users.columns.find((c) => c.name === 'created_at')!;
    expect(created.default).toBe('now()');
  });

  it('reads indexes (composite unique + named) and quoted column names', () => {
    const r = parse(text);
    const users = r.entities.find((e) => e.name === 'users')!;
    const idx = users.indexes!.find((i) => i.name === 'idx_login')!;
    expect(idx).toMatchObject({ columns: ['username', 'email'], unique: true });
    const roles = r.entities.find((e) => e.name === 'roles')!;
    expect(roles.columns.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('reports the Project database_type as an engine hint', () => {
    const r = parse(text);
    expect(r.engines).toEqual([{ engine: 'postgresql', line: expect.any(Number), detail: 'DBML database_type "PostgreSQL"' }]);
  });
});

describe('dbml refs', () => {
  it('handles all four operators, aliases, composite keys and delete actions', () => {
    const text = `
Table users as U { id int [pk] }
Table roles { id int [pk] }
Table posts { id int [pk] author_id int }
Table profiles { id int [pk] user_id int }
Table sessions { id int [pk] user_id int }
Table order_items { order_id int, product_id int }
Table orders { id int, sku int }

Ref: posts.author_id > U.id [delete: cascade]
Ref: U.id < sessions.user_id
Ref {
  profiles.user_id - users.id
}
Ref: order_items.(order_id, product_id) > orders.(id, sku)
`;
    const r = parse(text);
    const find = (fromCol: string) => r.relations.find((x) => x.fromColumns[0] === fromCol)!;

    const author = find('author_id');
    expect(author).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['author_id'], toColumns: ['id'], onDelete: 'CASCADE' });
    expect(author.from.name).toBe('posts');
    expect(author.to.name).toBe('users'); // alias U resolved

    const session = r.relations.find((x) => x.from.name === 'sessions')!;
    expect(session).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['user_id'], toColumns: ['id'] });
    expect(session.to.name).toBe('users');

    const profile = r.relations.find((x) => x.from.name === 'profiles')!;
    expect(profile).toMatchObject({ cardinality: 'one-to-one', fromColumns: ['user_id'], toColumns: ['id'] });

    const composite = r.relations.find((x) => x.fromColumns.length === 2)!;
    expect(composite).toMatchObject({ fromColumns: ['order_id', 'product_id'], toColumns: ['id', 'sku'], cardinality: 'many-to-one' });
    expect(composite.from.name).toBe('order_items');
    expect(composite.to.name).toBe('orders');
  });

  it('reads many-to-many refs', () => {
    const r = parse(`
Table students { id int [pk] }
Table courses { id int [pk] }
Ref: students.id <> courses.id
`);
    const m2m = r.relations[0];
    expect(m2m).toMatchObject({ cardinality: 'many-to-many' });
    expect([m2m.from.name, m2m.to.name].sort()).toEqual(['courses', 'students']);
  });
});

describe('dbml enums', () => {
  it('reads enum values ignoring notes', () => {
    const r = parse(`
Enum post_status {
  draft
  published [note: 'visible']
  archived
}
`);
    expect(r.enums).toEqual([{ name: 'post_status', values: ['draft', 'published', 'archived'], source: expect.anything() }]);
  });
});

describe('dbml robustness', () => {
  it('ignores commented-out code and look-alike syntax in strings', () => {
    const r = parse(`
// Table ghost { id int [pk] }
Table real {
  id int [pk]
  label varchar [note: 'Table fake { not real }']
}
/* Ref: real.id > ghost.id */
`);
    expect(r.entities.map((e) => e.name)).toEqual(['real']);
    expect(r.relations).toHaveLength(0);
  });

  it('does not throw on malformed input', () => {
    for (const bad of ['Table {', 'Table x { id', 'Ref:', 'Enum', 'Table a as', 'Ref { oops', '{]}[)(']) {
      expect(() => parse(bad)).not.toThrow();
    }
  });
});

describe('dbml end-to-end', () => {
  it('resolves entities, columns and relation directions users would expect', () => {
    const text = `
Table users {
  id integer [pk]
  email varchar [unique, not null]
}
Table posts {
  id integer [pk]
  author_id integer [not null, ref: > users.id]
  title varchar
}
Table comments {
  id integer [pk]
  post_id integer [not null]
}
Ref: comments.post_id > posts.id
`;
    const r = resolveSchema([fr(text)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['comments', 'posts', 'users']);

    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });

    const byPair = r.relations.map((x) => `${x.from}.${x.fromColumns[0]}->${x.to}.${x.toColumns[0]}`).sort();
    expect(byPair).toEqual(['comments.post_id->posts.id', 'posts.author_id->users.id']);

    const authorRel = r.relations.find((x) => x.from === 'posts')!;
    expect(authorRel).toMatchObject({ cardinality: 'many-to-one', optional: false, kind: 'foreign-key' });
  });
});
