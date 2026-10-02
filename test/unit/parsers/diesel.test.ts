import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { dieselParser } from '../../../src/parsers/diesel';

const parse = (text: string, path = 'src/schema.rs') => dieselParser.parse({ path, text });
const fr = (text: string, path = 'src/schema.rs'): FileResult => ({ file: path, kind: 'diesel', result: parse(text, path) });

describe('diesel detect', () => {
  it('requires the table! macro and does not claim SeaORM files', () => {
    expect(dieselParser.detect({ path: 'schema.rs', text: 'diesel::table! { users (id) { id -> Int4, } }' })).toBe(true);
    expect(dieselParser.detect({ path: 'schema.rs', text: 'table! { posts (id) { id -> Int8, } }' })).toBe(true);
    const seaorm = `#[derive(Clone, Debug, DeriveEntityModel)]\n#[sea_orm(table_name = "users")]\npub struct Model { pub id: i32 }`;
    expect(dieselParser.detect({ path: 'entity.rs', text: seaorm })).toBe(false);
    expect(dieselParser.detect({ path: 'main.rs', text: 'fn main() {}' })).toBe(false);
  });
});

const SCHEMA = `
// @generated automatically by Diesel CLI.

diesel::table! {
    use diesel::sql_types::*;

    users (id) {
        id -> Int4,
        #[max_length = 255]
        name -> Varchar,
        email -> Nullable<Text>,
        tags -> Array<Text>,
        #[sql_name = "type"]
        kind -> Varchar,
    }
}

table! {
    posts (id) {
        /// Primary key of the post
        id -> Int8,
        user_id -> Int4,
        title -> Nullable<Varchar>,
    }
}

diesel::table! {
    auth.sessions (id, user_id) {
        id -> Int4,
        user_id -> Int4,
    }
}

diesel::joinable!(posts -> users (user_id));
diesel::allow_tables_to_appear_in_same_query!(posts, users);
`;

describe('diesel tables', () => {
  it('parses columns, nullability, arrays, sql_name and max_length', () => {
    const r = parse(SCHEMA);
    const users = r.entities.find((e) => e.name === 'users')!;
    expect(users.nameCertainty).toBe(2);
    const by = (n: string) => users.columns.find((c) => c.name === n)!;
    expect(by('id')).toMatchObject({ type: 'Int4', primaryKey: true, nullable: false });
    expect(by('name')).toMatchObject({ type: 'Varchar(255)', nullable: false });
    expect(by('email')).toMatchObject({ type: 'Text', nullable: true });
    expect(by('tags')).toMatchObject({ type: 'Text', isArray: true, nullable: false });
    // #[sql_name = "type"] renames the diesel field `kind` to the real column `type`.
    expect(users.columns.map((c) => c.name)).toContain('type');
    expect(by('type')).toMatchObject({ type: 'Varchar' });
  });

  it('reads doc comments, nullable types and composite / schema-qualified tables', () => {
    const r = parse(SCHEMA);
    const posts = r.entities.find((e) => e.name === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'id')!.comment).toBe('Primary key of the post');
    expect(posts.columns.find((c) => c.name === 'title')).toMatchObject({ type: 'Varchar', nullable: true });

    const sessions = r.entities.find((e) => e.name === 'sessions')!;
    expect(sessions.schema).toBe('auth');
    expect(sessions.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['id', 'user_id']);
  });

  it('reads joinable! as a foreign key', () => {
    const r = parse(SCHEMA);
    const rel = r.relations.find((x) => x.from.name === 'posts')!;
    expect(rel).toMatchObject({ fromColumns: ['user_id'], to: { name: 'users' }, cardinality: 'many-to-one', kind: 'foreign-key' });
  });
});

describe('diesel robustness', () => {
  it('does not throw on malformed macros', () => {
    for (const bad of ['diesel::table! {', 'table! { users (id) {', 'table! {}', 'joinable!(', '-> -> ->']) {
      expect(() => parse(bad)).not.toThrow();
    }
  });
});

describe('diesel end-to-end', () => {
  it('resolves tables and the joinable foreign key', () => {
    const r = resolveSchema([fr(SCHEMA)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['auth.sessions', 'posts', 'users']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'user_id')!.references).toEqual({ entity: 'users', column: 'id' });
    const rel = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(rel).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['user_id'], toColumns: ['id'] });
  });
});
