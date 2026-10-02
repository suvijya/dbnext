import { describe, expect, it } from 'vitest';
import type { FileResult, SchemaOp } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { knexParser } from '../../../src/parsers/knex';

const parse = (path: string, text: string) => knexParser.parse({ path, text });
const file = (path: string, text: string): FileResult => ({ file: path, kind: 'knex', result: parse(path, text) });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('knex detect', () => {
  it('claims knex migrations / Objection models and rejects Kysely', () => {
    const mig = `exports.up = (knex) => knex.schema.createTable('users', (t) => { t.increments('id'); });`;
    const obj = `const { Model } = require('objection'); class P extends Model { static tableName = 'persons'; static get relationMappings() { return {}; } }`;
    const kysely = `import { Kysely } from 'kysely';
      export async function up(db) { await db.schema.createTable('x').addColumn('id', 'serial', (c) => c.primaryKey()).execute(); }`;
    expect(knexParser.detect({ path: '001.js', text: mig })).toBe(true);
    expect(knexParser.detect({ path: 'person.js', text: obj })).toBe(true);
    expect(knexParser.detect({ path: 'm.ts', text: kysely })).toBe(false);
    expect(knexParser.detect({ path: 'x.ts', text: 'export const a = 1;' })).toBe(false);
  });
});

const MIGRATION = `
exports.up = function (knex) {
  return knex.schema
    .createTable('users', (table) => {
      table.increments('id');
      table.string('email', 255).notNullable().unique();
      table.string('name').nullable();
      table.enu('role', ['admin', 'user']).notNullable().defaultTo('user');
      table.timestamps(true, true);
    })
    .createTable('posts', (table) => {
      table.increments('id');
      table.integer('author_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.text('body');
    });
};

exports.down = function (knex) {
  return knex.schema.dropTable('posts').dropTable('users');
};
`;

describe('knex migrations', () => {
  it('parses the UP direction only, column types, enum and the FK', () => {
    const result = parse('migrations/001_init.js', MIGRATION);
    expect(result.origin).toBe('migration');
    expect(result.ops ?? []).toEqual([]); // the down drops are ignored

    const r = resolveSchema([{ file: 'migrations/001_init.js', kind: 'knex', result }]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']);

    const users = r.entities.find((e) => e.id === 'users')!;
    expect(names(users.columns)).toEqual(['id', 'email', 'name', 'role', 'created_at', 'updated_at']);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'integer', primaryKey: true, generated: true, nullable: false });
    expect(users.columns[1]).toMatchObject({ type: 'varchar(255)', nullable: false, unique: true });
    expect(users.columns[2]).toMatchObject({ name: 'name', nullable: true });
    expect(users.columns[3]).toMatchObject({ name: 'role', nullable: false, default: "'user'" });
    expect(r.enums.find((e) => e.id === 'users_role')!.values).toEqual(['admin', 'user']);

    const posts = r.entities.find((e) => e.id === 'posts')!;
    const fk = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(fk).toMatchObject({ fromColumns: ['author_id'], toColumns: ['id'], cardinality: 'many-to-one', optional: false, onDelete: 'CASCADE' });
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
  });

  it('emits ops for alterTable add / drop / rename / alter', () => {
    const text = `
      exports.up = async (knex) => {
        await knex.schema.alterTable('users', (t) => {
          t.string('phone');
          t.dropColumn('bio');
          t.renameColumn('name', 'full_name');
          t.string('email').notNullable().alter();
        });
      };
      exports.down = async (knex) => { await knex.schema.alterTable('users', (t) => t.dropColumn('phone')); };`;
    const result = parse('migrations/002.js', text);
    const added = result.entities.find((e) => e.name === 'users')!;
    expect(added.partial).toBe(true);
    expect(names(added.columns)).toEqual(['phone']);
    const ops = result.ops ?? [];
    expect(ops.find((o) => o.op === 'dropColumn')).toMatchObject({ op: 'dropColumn', column: 'bio' });
    expect(ops.find((o) => o.op === 'renameColumn')).toMatchObject({ column: 'name', to: 'full_name' });
    const alter = ops.find((o): o is Extract<SchemaOp, { op: 'alterColumn' }> => o.op === 'alterColumn')!;
    expect(alter.column).toBe('email');
    expect(alter.set).toMatchObject({ nullable: false });
  });
});

describe('knex Objection models', () => {
  it('reads tableName and relationMappings', () => {
    const text = `
      const { Model } = require('objection');
      class Person extends Model {
        static get tableName() { return 'persons'; }
        static get relationMappings() {
          return {
            pets: {
              relation: Model.HasManyRelation,
              modelClass: Animal,
              join: { from: 'persons.id', to: 'animals.owner_id' },
            },
          };
        }
      }
      class Animal extends Model {
        static tableName = 'animals';
      }`;
    const r = resolveSchema([file('models/person.js', text)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['animals', 'persons']);
    const rel = r.relations.find((x) => x.from === 'animals' && x.to === 'persons')!;
    expect(rel).toMatchObject({ fromColumns: ['owner_id'], toColumns: ['id'], cardinality: 'many-to-one' });
  });

  it('does not throw on malformed migrations', () => {
    expect(() => parse('bad.js', `exports.up = (knex) => knex.schema.createTable('x', (t) => { t.string('a'`)).not.toThrow();
  });
});
