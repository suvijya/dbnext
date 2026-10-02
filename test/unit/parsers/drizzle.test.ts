import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { drizzleParser } from '../../../src/parsers/drizzle';

const parse = (path: string, text: string) => drizzleParser.parse({ path, text });
const file = (path: string, text: string): FileResult => ({ file: path, kind: 'drizzle', result: parse(path, text) });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('drizzle detect', () => {
  it('claims Drizzle schema files and rejects neighbours', () => {
    const pg = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name') });`;
    expect(drizzleParser.detect({ path: 'schema.ts', text: pg })).toBe(true);
    expect(drizzleParser.detect({ path: 'knex.ts', text: `exports.up = (knex) => knex.schema.createTable('x', (t) => t.increments());` })).toBe(false);
    expect(drizzleParser.detect({ path: 'plain.ts', text: 'export const x = 1;' })).toBe(false);
  });
});

const PG = `
import { pgTable, serial, integer, varchar, text, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const roleEnum = pgEnum('role', ['admin', 'user']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  role: roleEnum('role').default('user'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
}, (t) => [
  index('author_idx').on(t.authorId),
  uniqueIndex('title_idx').on(t.title),
]);

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
`;

describe('drizzle pg-core', () => {
  it('maps columns, enums, indexes, engine and the FK end to end', () => {
    const r = resolveSchema([file('src/db/schema.ts', PG)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']);

    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.modelNames).toEqual(['users']);
    expect(users.engine).toBe('postgresql');
    expect(names(users.columns)).toEqual(['id', 'email', 'role', 'created_at']);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'serial', primaryKey: true, generated: true, nullable: false });
    expect(users.columns[1]).toMatchObject({ type: 'varchar(255)', unique: true, nullable: false });
    expect(users.columns[2]).toMatchObject({ default: "'user'" });
    expect(users.columns[3]).toMatchObject({ default: 'now()' });

    expect(r.enums.find((e) => e.id === 'role')!.values).toEqual(['admin', 'user']);
    expect(users.columns[2].enumRef).toBe('role');

    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(names(posts.columns)).toEqual(['id', 'author_id', 'title']);
    expect(posts.indexes.map((i) => `${i.columns.join(',')}:${i.unique}`).sort()).toEqual(['author_id:false', 'title:true']);

    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({
      from: 'posts',
      to: 'users',
      fromColumns: ['author_id'],
      toColumns: ['id'],
      cardinality: 'many-to-one',
      onDelete: 'cascade',
      kind: 'foreign-key',
    });
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
  });
});

describe('drizzle other dialects and constraint helpers', () => {
  it('handles mysqlTable, schema scopes, composite PK and foreignKey()', () => {
    const text = `
      import { mysqlTable, int, varchar, primaryKey, foreignKey } from 'drizzle-orm/mysql-core';
      export const members = mysqlTable('members', {
        orgId: int('org_id').notNull(),
        userId: int('user_id').notNull(),
      }, (t) => ({
        pk: primaryKey({ columns: [t.orgId, t.userId] }),
        orgFk: foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
      }));
      export const orgs = mysqlTable('orgs', {
        id: int('id').primaryKey(),
        name: varchar('name', { length: 100 }).notNull(),
      });`;
    const r = resolveSchema([file('schema.ts', text)]);
    const members = r.entities.find((e) => e.id === 'members')!;
    expect(members.engine).toBe('mysql');
    expect(members.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['org_id', 'user_id']);
    const fk = r.relations.find((x) => x.from === 'members' && x.to === 'orgs')!;
    expect(fk).toMatchObject({ fromColumns: ['org_id'], toColumns: ['id'], cardinality: 'many-to-one' });
  });

  it('reads pgSchema-scoped tables with a non-default schema', () => {
    const text = `
      import { pgSchema, uuid, text } from 'drizzle-orm/pg-core';
      export const authSchema = pgSchema('auth');
      export const accounts = authSchema.table('accounts', {
        id: uuid('id').primaryKey(),
        username: text('username').notNull(),
      });`;
    const r = resolveSchema([file('schema.ts', text)]);
    const acc = r.entities.find((e) => e.id === 'auth.accounts')!;
    expect(acc).toBeTruthy();
    expect(acc.schema).toBe('auth');
    expect(names(acc.columns)).toEqual(['id', 'username']);
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('x.ts', `export const t = pgTable('t', { id: serial('id').primaryKey(`)).not.toThrow();
  });
});
