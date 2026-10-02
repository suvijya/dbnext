import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { kyselyParser } from '../../../src/parsers/kysely';

const parse = (path: string, text: string) => kyselyParser.parse({ path, text });
const file = (path: string, text: string): FileResult => ({ file: path, kind: 'kysely', result: parse(path, text) });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('kysely detect', () => {
  it('claims kysely migrations / Database types and rejects knex', () => {
    const mig = `import { Kysely } from 'kysely';
      export async function up(db) { await db.schema.createTable('person').addColumn('id', 'serial', (c) => c.primaryKey()).execute(); }`;
    const types = `import { Generated, ColumnType } from 'kysely';
      export interface Database { person: PersonTable }
      export interface PersonTable { id: Generated<number>; name: string }`;
    const knex = `exports.up = (knex) => knex.schema.createTable('x', (t) => { t.increments('id'); });`;
    expect(kyselyParser.detect({ path: 'm.ts', text: mig })).toBe(true);
    expect(kyselyParser.detect({ path: 'types.ts', text: types })).toBe(true);
    expect(kyselyParser.detect({ path: '001.js', text: knex })).toBe(false);
    expect(kyselyParser.detect({ path: 'x.ts', text: 'export const a = 1;' })).toBe(false);
  });
});

const MIGRATION = `
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('person')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('first_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('email', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('created_at', sql\`timestamp\`, (col) => col.defaultTo(sql\`now()\`))
    .execute();

  await db.schema
    .createTable('pet')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('owner_id', 'integer', (col) => col.references('person.id').onDelete('cascade').notNull())
    .addColumn('name', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('pet').execute();
  await db.schema.dropTable('person').execute();
}
`;

describe('kysely migrations', () => {
  it('parses the up direction, column types and the FK, ignoring down', () => {
    const result = parse('migrations/001.ts', MIGRATION);
    expect(result.origin).toBe('migration');
    expect(result.ops ?? []).toEqual([]);

    const r = resolveSchema([{ file: 'migrations/001.ts', kind: 'kysely', result }]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['person', 'pet']);

    const person = r.entities.find((e) => e.id === 'person')!;
    expect(names(person.columns)).toEqual(['id', 'first_name', 'email', 'created_at']);
    expect(person.columns[0]).toMatchObject({ name: 'id', type: 'serial', primaryKey: true, nullable: false });
    expect(person.columns[1]).toMatchObject({ type: 'varchar(255)', nullable: false });
    expect(person.columns[2]).toMatchObject({ unique: true, nullable: false });
    expect(person.columns[3]).toMatchObject({ name: 'created_at', type: 'timestamp', default: 'now()' });

    const pet = r.entities.find((e) => e.id === 'pet')!;
    expect(pet.columns.find((c) => c.name === 'owner_id')!.nullable).toBe(false);
    const fk = r.relations.find((x) => x.from === 'pet' && x.to === 'person')!;
    expect(fk).toMatchObject({ fromColumns: ['owner_id'], toColumns: ['id'], cardinality: 'many-to-one', optional: false, onDelete: 'cascade' });
  });

  it('handles constraints, enums and alterTable ops', () => {
    const text = `
      import { Kysely } from 'kysely';
      export async function up(db) {
        await db.schema.createType('mood').asEnum(['happy', 'sad']).execute();
        await db.schema.createTable('membership')
          .addColumn('org_id', 'integer')
          .addColumn('user_id', 'integer')
          .addPrimaryKeyConstraint('membership_pk', ['org_id', 'user_id'])
          .addForeignKeyConstraint('fk_org', ['org_id'], 'orgs', ['id'], (cb) => cb.onDelete('cascade'))
          .execute();
        await db.schema.alterTable('person').addColumn('age', 'integer').execute();
        await db.schema.alterTable('person').dropColumn('nickname').execute();
      }`;
    const result = parse('migrations/002.ts', text);
    expect(result.enums.find((e) => e.name === 'mood')!.values).toEqual(['happy', 'sad']);
    const membership = result.entities.find((e) => e.name === 'membership')!;
    expect(membership.columns.filter((c) => c.primaryKey).map((c) => c.name).sort()).toEqual(['org_id', 'user_id']);
    expect(result.relations.find((x) => x.to.name === 'orgs')).toMatchObject({ fromColumns: ['org_id'], toColumns: ['id'], onDelete: 'cascade' });
    const added = result.entities.find((e) => e.name === 'person' && e.partial)!;
    expect(names(added.columns)).toEqual(['age']);
    expect((result.ops ?? []).find((o) => o.op === 'dropColumn')).toMatchObject({ column: 'nickname' });
  });
});

const TYPES = `
import { Kysely, Generated, ColumnType } from 'kysely';

export interface Database {
  person: PersonTable;
  'auth.account': AccountTable;
}

export interface PersonTable {
  id: Generated<number>;
  first_name: string;
  last_name: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface AccountTable {
  id: Generated<string>;
  email: string;
}

export const db = new Kysely<Database>({});
`;

describe('kysely Database interface types', () => {
  it('creates one entity per Database key with Generated / ColumnType columns', () => {
    const r = resolveSchema([file('src/db/types.ts', TYPES)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['auth.account', 'person']);

    const person = r.entities.find((e) => e.id === 'person')!;
    expect(person.modelNames).toEqual(['PersonTable']);
    expect(names(person.columns)).toEqual(['id', 'first_name', 'last_name', 'created_at']);
    expect(person.columns[0]).toMatchObject({ name: 'id', type: 'number', generated: true, nullable: false });
    expect(person.columns[1]).toMatchObject({ type: 'string', nullable: false });
    expect(person.columns[2]).toMatchObject({ name: 'last_name', nullable: true });
    expect(person.columns[3]).toMatchObject({ name: 'created_at', type: 'Date' });

    const account = r.entities.find((e) => e.id === 'auth.account')!;
    expect(account.schema).toBe('auth');
    expect(names(account.columns)).toEqual(['id', 'email']);
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('x.ts', `export interface Database { person: PersonTable `)).not.toThrow();
    expect(() => parse('y.ts', `export async function up(db) { await db.schema.createTable('t').addColumn('id'`)).not.toThrow();
  });
});
