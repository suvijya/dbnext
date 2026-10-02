import { describe, expect, it } from 'vitest';
import type { Column, FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { sequelizeParser } from '../../../src/parsers/sequelize';

const parse = (text: string, path = 'model.ts') => sequelizeParser.parse({ path, text });
const fr = (text: string, path = 'model.ts'): FileResult => ({ file: path, kind: 'sequelize', result: parse(text, path) });
const colNames = (cols: Column[]) => cols.map((c) => c.name);
const findCol = (cols: Column[], name: string) => cols.find((c) => c.name === name);

describe('sequelize: detect', () => {
  it('matches sequelize code and migrations', () => {
    expect(sequelizeParser.detect({ path: 'a.ts', text: `import { DataTypes } from 'sequelize';\nsequelize.define('User', {});` })).toBe(true);
    expect(sequelizeParser.detect({ path: 'a.ts', text: `import { Table } from 'sequelize-typescript';` })).toBe(true);
    expect(sequelizeParser.detect({ path: 'm.js', text: `module.exports = { up: (queryInterface, Sequelize) => queryInterface.createTable('X', {}) };` })).toBe(true);
    expect(sequelizeParser.detect({ path: 'f.js', text: `module.exports = (sequelize, DataTypes) => { class User extends Model {} User.init({}, {sequelize}); };` })).toBe(true);
  });

  it('does not match neighbours', () => {
    expect(sequelizeParser.detect({ path: 'a.ts', text: `import { Entity } from 'typeorm';\n@Entity() class U {}` })).toBe(false);
    expect(sequelizeParser.detect({ path: 'a.ts', text: `import mongoose from 'mongoose';\nnew mongoose.Schema({});` })).toBe(false);
    expect(sequelizeParser.detect({ path: 'a.ts', text: `import { pgTable } from 'drizzle-orm';\npgTable('t', {});` })).toBe(false);
    expect(sequelizeParser.detect({ path: 'a.ts', text: `knex.schema.createTable('t', (t) => {});` })).toBe(false);
  });
});

describe('sequelize: define()', () => {
  const text = `
    import { Sequelize, DataTypes } from 'sequelize';
    const sequelize = new Sequelize();
    const User = sequelize.define('User', {
      firstName: { type: DataTypes.STRING, allowNull: false, field: 'first_name' },
      age: DataTypes.INTEGER,
      email: { type: DataTypes.STRING, unique: true },
    }, { tableName: 'users' });
  `;

  it('builds the table, implicit id and timestamps', () => {
    const r = parse(text);
    const user = r.entities[0];
    expect(user).toMatchObject({ name: 'users', nameCertainty: 2, modelName: 'User', kind: 'table' });
    expect(colNames(user.columns)).toEqual(['id', 'first_name', 'age', 'email', 'createdAt', 'updatedAt']);
    expect(findCol(user.columns, 'id')).toMatchObject({ primaryKey: true, nullable: false, generated: true, type: 'INTEGER' });
    expect(findCol(user.columns, 'first_name')).toMatchObject({ type: 'STRING', nullable: false });
    expect(findCol(user.columns, 'email')).toMatchObject({ unique: true });
    expect(findCol(user.columns, 'createdAt')).toMatchObject({ type: 'DATE', nullable: false });
  });

  it('applies underscored names, disables timestamps and reads references', () => {
    const r = parse(`
      import { DataTypes } from 'sequelize';
      const Post = sequelize.define('Post', {
        title: DataTypes.STRING,
        authorId: { type: DataTypes.INTEGER, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      }, { underscored: true, timestamps: false });
    `);
    const post = r.entities[0];
    expect(colNames(post.columns)).toEqual(['id', 'title', 'author_id']);
    expect(r.relations).toEqual([
      expect.objectContaining({ from: { model: 'Post' }, fromColumns: ['author_id'], to: { name: 'users' }, toColumns: ['id'], kind: 'foreign-key', onDelete: 'CASCADE' }),
    ]);
  });

  it('derives pluralized table name by default (certainty 0) and respects freezeTableName / paranoid', () => {
    const def = parse(`import { DataTypes } from 'sequelize'; sequelize.define('Category', { name: DataTypes.STRING });`).entities[0];
    expect(def).toMatchObject({ name: 'Categories', nameCertainty: 0 });
    const frozen = parse(`import { DataTypes } from 'sequelize'; sequelize.define('Category', { name: DataTypes.STRING }, { freezeTableName: true, paranoid: true });`).entities[0];
    expect(frozen.name).toBe('Category');
    expect(colNames(frozen.columns)).toContain('deletedAt');
  });
});

describe('sequelize: class.init()', () => {
  it('reads a Model.init definition with an explicit primary key', () => {
    const r = parse(`
      import { Model, DataTypes } from 'sequelize';
      class User extends Model {}
      User.init({
        uuid: { type: DataTypes.UUID, primaryKey: true },
        name: DataTypes.STRING,
      }, { sequelize, modelName: 'User', tableName: 'users' });
    `);
    const user = r.entities[0];
    expect(user).toMatchObject({ name: 'users', modelName: 'User' });
    expect(colNames(user.columns)).toEqual(['uuid', 'name', 'createdAt', 'updatedAt']);
    expect(findCol(user.columns, 'uuid')).toMatchObject({ primaryKey: true, nullable: false });
    expect(user.columns.some((c) => c.name === 'id')).toBe(false);
  });
});

describe('sequelize: sequelize-typescript', () => {
  const text = `
    import { Table, Column, Model, PrimaryKey, AutoIncrement, DataType, ForeignKey, BelongsTo, HasMany } from 'sequelize-typescript';

    @Table({ tableName: 'teams' })
    class Team extends Model {
      @PrimaryKey @AutoIncrement @Column(DataType.INTEGER) id: number;
      @Column(DataType.STRING) name: string;
      @HasMany(() => Player) players: Player[];
    }

    @Table({ tableName: 'players', timestamps: false })
    class Player extends Model {
      @PrimaryKey @AutoIncrement @Column id: number;
      @Column(DataType.STRING) name: string;
      @ForeignKey(() => Team) @Column teamId: number;
      @BelongsTo(() => Team) team: Team;
    }
  `;

  it('parses decorated columns and does not treat navigation props as columns', () => {
    const r = parse(text);
    const team = r.entities.find((e) => e.modelName === 'Team')!;
    expect(colNames(team.columns)).toEqual(['id', 'name', 'createdAt', 'updatedAt']);
    expect(findCol(team.columns, 'id')).toMatchObject({ primaryKey: true, generated: true, type: 'INTEGER' });
    const player = r.entities.find((e) => e.modelName === 'Player')!;
    expect(colNames(player.columns)).toEqual(['id', 'name', 'teamId']); // timestamps:false, team not a column
    expect(findCol(player.columns, 'teamId')).toMatchObject({ type: 'INTEGER' });
  });

  it('links the @ForeignKey / @BelongsTo / @HasMany association', () => {
    const schema = resolveSchema([fr(text)]);
    const rel = schema.relations.find((x) => x.cardinality === 'many-to-one')!;
    expect(rel).toMatchObject({ from: 'players', to: 'teams', fromColumns: ['teamId'] });
  });
});

describe('sequelize: associations', () => {
  it('belongsTo / hasMany / hasOne / belongsToMany', () => {
    const r = parse(`
      import { DataTypes } from 'sequelize';
      Post.belongsTo(User, { foreignKey: 'authorId', onDelete: 'SET NULL' });
      User.hasMany(Post);
      User.hasOne(Profile);
      Post.belongsToMany(Tag, { through: 'PostTags' });
    `);
    const kinds = r.relations.map((x) => `${x.cardinality}:${x.from.model}->${x.to.model}`);
    expect(kinds).toContain('many-to-one:Post->User');
    expect(kinds).toContain('one-to-many:User->Post');
    expect(kinds).toContain('one-to-one:Profile->User');
    const belongs = r.relations.find((x) => x.cardinality === 'many-to-one')!;
    expect(belongs).toMatchObject({ fromColumns: ['authorId'], onDelete: 'SET NULL' });
    const hasOne = r.relations.find((x) => x.cardinality === 'one-to-one')!;
    expect(hasOne).toMatchObject({ from: { model: 'Profile' }, fromColumns: ['userId'], to: { model: 'User' } });
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: { model: 'Post' }, to: { model: 'Tag' }, through: { name: 'PostTags' } });
  });

  it('resolves `this` inside static associate(models)', () => {
    const r = parse(`
      module.exports = (sequelize, DataTypes) => {
        class User extends Model {
          static associate(models) {
            this.hasMany(models.Post, { foreignKey: 'authorId' });
          }
        }
        User.init({ name: DataTypes.STRING }, { sequelize, modelName: 'User' });
        return User;
      };
    `);
    const rel = r.relations.find((x) => x.cardinality === 'one-to-many')!;
    expect(rel).toMatchObject({ from: { model: 'User' }, to: { model: 'Post' }, toColumns: ['authorId'] });
  });
});

describe('sequelize: migrations', () => {
  it('reads createTable with references (UP only, ignoring down)', () => {
    const text = `
      'use strict';
      module.exports = {
        async up(queryInterface, Sequelize) {
          await queryInterface.createTable('Users', {
            id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER },
            email: { type: Sequelize.STRING, allowNull: false },
          });
          await queryInterface.createTable('Posts', {
            id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER },
            userId: { type: Sequelize.INTEGER, references: { model: 'Users', key: 'id' }, onDelete: 'CASCADE' },
          });
        },
        async down(queryInterface) {
          await queryInterface.dropTable('Posts');
          await queryInterface.dropTable('Users');
        },
      };
    `;
    const r = parse(text, 'migrations/001-init.js');
    expect(r.origin).toBe('migration');
    expect(r.entities.map((e) => e.name).sort()).toEqual(['Posts', 'Users']);

    const schema = resolveSchema([fr(text, 'migrations/001-init.js')]);
    expect(schema.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']); // down's dropTable ignored
    expect(schema.relations).toEqual([
      expect.objectContaining({ from: 'posts', to: 'users', fromColumns: ['userId'], onDelete: 'CASCADE' }),
    ]);
  });

  it('reads addColumn / changeColumn / renameColumn / removeColumn ops', () => {
    const r = parse(`
      module.exports = {
        up: async (queryInterface, Sequelize) => {
          await queryInterface.addColumn('Users', 'nickname', { type: Sequelize.STRING, allowNull: false });
          await queryInterface.changeColumn('Users', 'email', { type: Sequelize.TEXT, allowNull: true });
          await queryInterface.renameColumn('Users', 'nickname', 'handle');
          await queryInterface.removeColumn('Users', 'legacy');
        },
        down: async () => {},
      };
    `, 'migrations/002.js');
    expect(r.origin).toBe('migration');
    const added = r.entities.find((e) => e.partial);
    expect(added).toMatchObject({ name: 'Users' });
    expect(findCol(added!.columns, 'nickname')).toMatchObject({ type: 'STRING', nullable: false });
    const opTypes = (r.ops ?? []).map((o) => o.op);
    expect(opTypes).toEqual(['alterColumn', 'renameColumn', 'dropColumn']);
    const alter = (r.ops ?? []).find((o) => o.op === 'alterColumn')!;
    expect(alter).toMatchObject({ column: 'email', set: { type: 'TEXT', nullable: true } });
  });

  it('reads addConstraint (foreign key) and addIndex', () => {
    const r = parse(`
      module.exports = {
        async up(queryInterface) {
          await queryInterface.addConstraint('Posts', { type: 'foreign key', fields: ['authorId'], references: { table: 'Users', field: 'id' }, onDelete: 'CASCADE' });
          await queryInterface.addIndex('Users', ['email'], { unique: true, name: 'users_email_uq' });
        },
      };
    `, 'migrations/003.js');
    expect(r.relations).toEqual([
      expect.objectContaining({ from: { name: 'Posts' }, fromColumns: ['authorId'], to: { name: 'Users' }, toColumns: ['id'], kind: 'foreign-key' }),
    ]);
    const indexed = r.entities.find((e) => e.indexes?.length);
    expect(indexed!.indexes![0]).toMatchObject({ columns: ['email'], unique: true, name: 'users_email_uq' });
  });
});

describe('sequelize: robustness', () => {
  it('does not throw on malformed / commented-out input', () => {
    for (const text of [
      `import { DataTypes } from 'sequelize'; sequelize.define('User', {`,
      `import { DataTypes } from 'sequelize'; sequelize.define('User', { a: });`,
      `// sequelize.define('User', { a: DataTypes.STRING });`,
      `const s = "queryInterface.createTable('X', {})";`,
      '',
      `module.exports = { up: async (q) => { await q.createTable('X'); } };`,
    ]) {
      expect(() => parse(text)).not.toThrow();
    }
  });
});

describe('sequelize: end-to-end via resolveSchema', () => {
  it('links a two-model project with belongsTo/hasMany', () => {
    const text = `
      import { Model, DataTypes } from 'sequelize';
      class User extends Model {}
      User.init({ email: { type: DataTypes.STRING, unique: true } }, { sequelize, modelName: 'User' });
      class Post extends Model {}
      Post.init({ title: DataTypes.STRING, authorId: DataTypes.INTEGER }, { sequelize, modelName: 'Post' });
      Post.belongsTo(User, { foreignKey: 'authorId' });
      User.hasMany(Post, { foreignKey: 'authorId' });
    `;
    const schema = resolveSchema([fr(text)]);
    expect(schema.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']);
    const rels = schema.relations.filter((x) => x.from === 'posts' && x.to === 'users');
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ fromColumns: ['authorId'], cardinality: 'many-to-one' });
  });
});
