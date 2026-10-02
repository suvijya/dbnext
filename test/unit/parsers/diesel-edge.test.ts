import { describe, expect, it } from 'vitest';
import { dieselParser } from '../../../src/parsers/diesel';

// Edge-case coverage for the Diesel `table!` parser.
const parse = (text: string) => dieselParser.parse({ path: 'src/schema.rs', text });

describe('diesel — types & attributes', () => {
  it('unwraps Nullable / Array (incl. nested) and applies #[max_length] / #[sql_name]', () => {
    const rs = [
      'diesel::table! {',
      '    items (id) {',
      '        id -> Int4,',
      '        #[max_length = 255]',
      '        name -> Varchar,',
      '        description -> Nullable<Text>,',
      '        tags -> Array<Text>,',
      '        notes -> Array<Nullable<Text>>,',
      '        #[sql_name = "type"]',
      '        kind -> Varchar,',
      '    }',
      '}',
    ].join('\n');
    const t = parse(rs).entities.find((e) => e.name === 'items');
    const by = (n: string) => t?.columns.find((c) => c.name === n);
    expect(by('id')).toMatchObject({ type: 'Int4', primaryKey: true, nullable: false });
    expect(by('name')).toMatchObject({ type: 'Varchar(255)', nullable: false });
    expect(by('description')).toMatchObject({ type: 'Text', nullable: true });
    expect(by('tags')).toMatchObject({ type: 'Text', isArray: true, nullable: false });
    expect(by('notes')).toMatchObject({ isArray: true, nullable: true });
    // #[sql_name = "type"] renames field `kind` to the real column `type`.
    expect(t?.columns.map((c) => c.name)).toContain('type');
    expect(t?.columns.map((c) => c.name)).not.toContain('kind');
  });

  it('reads composite primary keys and schema-qualified table names', () => {
    const rs = ['diesel::table! {', '    auth.sessions (user_id, token) {', '        user_id -> Int4,', '        token -> Text,', '        data -> Nullable<Jsonb>,', '    }', '}'].join('\n');
    const t = parse(rs).entities.find((e) => e.name === 'sessions');
    expect(t?.schema).toBe('auth');
    expect(t?.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['user_id', 'token']);
  });

  it('reads joinable!(child -> parent (fk)) as a foreign key', () => {
    const rs = [
      'diesel::table! { posts (id) { id -> Int4, author_id -> Int4, } }',
      'diesel::table! { users (id) { id -> Int4, } }',
      'diesel::joinable!(posts -> users (author_id));',
    ].join('\n');
    const rel = parse(rs).relations.find((r) => r.from.name === 'posts');
    expect(rel).toMatchObject({ fromColumns: ['author_id'], to: { name: 'users' }, cardinality: 'many-to-one', kind: 'foreign-key' });
  });
});

describe('diesel — robustness', () => {
  it('never throws on truncated / malformed input', () => {
    for (const bad of ['diesel::table! {', 'table! { users (id) {', 'table! {}', 'joinable!(', '-> -> ->', 'table! { t () { } }']) {
      expect(() => parse(bad)).not.toThrow();
    }
  });

  it('CRLF line endings produce the identical result to LF', () => {
    const lf = [
      '// @generated automatically by Diesel CLI.',
      'diesel::table! {',
      '    users (id) {',
      '        id -> Int4,',
      '        #[max_length = 255]',
      '        email -> Varchar,',
      '    }',
      '}',
      'diesel::joinable!(posts -> users (user_id));',
    ].join('\n');
    expect(JSON.stringify(parse(lf))).toBe(JSON.stringify(parse(lf.replace(/\n/g, '\r\n'))));
  });
});
