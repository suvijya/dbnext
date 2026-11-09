import { describe, expect, it } from 'vitest';
import { diffSchemas } from '../../src/core/diff';
import { introspectToModel, type CatalogColumnRow, type CatalogConstraintRow } from '../../src/core/introspect';

const col = (table: string, name: string, type: string, position: number, nullable: boolean | string = 'NO', extra: Partial<CatalogColumnRow> = {}): CatalogColumnRow =>
  ({ schema: 'public', table, name, type, nullable, position, tableType: 'BASE TABLE', ...extra });

const columns: CatalogColumnRow[] = [
  col('users', 'email', 'TEXT', 2),
  col('users', 'id', 'integer', 1),
  col('profiles', 'id', 'integer', 1),
  col('profiles', 'user_id', 'integer', 2),
  col('posts', 'id', 'integer', 1, 'NO', { default: "nextval('posts_id_seq')" }),
  col('posts', 'author_id', 'integer', 2, 'YES'),
  col('active_users', 'id', 'integer', 1, true, { tableType: 'VIEW' }),
];

const constraints: CatalogConstraintRow[] = [
  { schema: 'public', table: 'users', name: 'users_pkey', type: 'p', column: 'id', position: 1 },
  { schema: 'public', table: 'users', name: 'users_email_key', type: 'u', column: 'email', position: 1 },
  { schema: 'public', table: 'posts', name: 'posts_pkey', type: 'PRIMARY KEY', column: 'id', position: 1 },
  { schema: 'public', table: 'posts', name: 'posts_author_fk', type: 'f', column: 'author_id', position: 1, refSchema: 'public', refTable: 'users', refColumn: 'id' },
  { schema: 'public', table: 'profiles', name: 'profiles_user_key', type: 'UNIQUE', column: 'user_id', position: 1 },
  { schema: 'public', table: 'profiles', name: 'profiles_user_fk', type: 'FOREIGN KEY', column: 'user_id', position: 1, refSchema: 'public', refTable: 'users', refColumn: 'id' },
];

const model = () => introspectToModel({ columns, constraints, engine: 'postgresql', workspaceName: 'db', now: new Date(0) });

describe('introspectToModel', () => {
  it('maps tables, views, columns, keys and defaults', () => {
    const m = model();
    expect(m.entities.map((e) => e.id)).toEqual(['active_users', 'posts', 'profiles', 'users']);
    const users = m.entities.find((e) => e.id === 'users')!;
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(users.columns[0]).toMatchObject({ primaryKey: true, unique: true, nullable: false, type: 'integer' });
    expect(users.columns[1]).toMatchObject({ unique: true, type: 'text' });
    expect(users.indexes).toEqual([{ name: 'users_email_key', columns: ['email'], unique: true }]);
    expect(m.entities.find((e) => e.id === 'active_users')!.kind).toBe('view');
    expect(m.entities.find((e) => e.id === 'posts')!.columns[0].default).toBe("nextval('posts_id_seq')");
  });

  it('maps foreign keys with cardinality and optionality', () => {
    const m = model();
    expect(m.relations.map((r) => [r.from, r.to, r.cardinality, r.optional, r.kind])).toEqual([
      ['posts', 'users', 'many-to-one', true, 'foreign-key'],
      ['profiles', 'users', 'one-to-one', false, 'foreign-key'],
    ]);
    expect(m.entities.find((e) => e.id === 'posts')!.columns[1].references).toEqual({ entity: 'users', column: 'id' });
  });

  it('produces a model the diff understands', () => {
    const live = model();
    const code = { ...live, entities: live.entities.filter((e) => e.id !== 'posts'), relations: live.relations.filter((r) => r.from !== 'posts') };
    expect(diffSchemas(code, live).entities.map((c) => [c.id, c.kind])).toContainEqual(['posts', 'added']);
  });

  it('handles an empty catalog', () => {
    const m = introspectToModel({ columns: [], constraints: [], engine: 'mysql', workspaceName: 'x' });
    expect(m.entities).toEqual([]);
  });
});