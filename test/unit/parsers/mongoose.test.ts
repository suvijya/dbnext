import { describe, expect, it } from 'vitest';
import type { Column, FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { mongooseParser } from '../../../src/parsers/mongoose';

const parse = (text: string, path = 'model.ts') => mongooseParser.parse({ path, text });
const fr = (text: string, path = 'model.ts'): FileResult => ({ file: path, kind: 'mongoose', result: parse(text, path) });
const colNames = (cols: Column[]) => cols.map((c) => c.name);
const findCol = (cols: Column[], name: string) => cols.find((c) => c.name === name);

describe('mongoose: detect', () => {
  it('matches mongoose schemas and models', () => {
    expect(mongooseParser.detect({ path: 'a.ts', text: `import mongoose from 'mongoose';\nconst s = new mongoose.Schema({});` })).toBe(true);
    expect(mongooseParser.detect({ path: 'a.ts', text: `import { Schema, model } from 'mongoose';\nconst s = new Schema({});` })).toBe(true);
    expect(mongooseParser.detect({ path: 'a.ts', text: `import { Prop, Schema } from '@nestjs/mongoose';` })).toBe(true);
  });

  it('does not match neighbours or plain mongoose connections', () => {
    expect(mongooseParser.detect({ path: 'a.ts', text: `import { Entity, Column } from 'typeorm';\n@Entity() class User {}` })).toBe(false);
    expect(mongooseParser.detect({ path: 'a.ts', text: `import { DataTypes } from 'sequelize';\nsequelize.define('User', {});` })).toBe(false);
    expect(mongooseParser.detect({ path: 'a.ts', text: `import { pgTable } from 'drizzle-orm';\nexport const users = pgTable('users', {});` })).toBe(false);
    expect(mongooseParser.detect({ path: 'a.ts', text: `import mongoose from 'mongoose';\nmongoose.connect(url);` })).toBe(false);
  });
});

describe('mongoose: classic schema', () => {
  const text = `
    import mongoose, { Schema } from 'mongoose';

    const userSchema = new mongoose.Schema({
      name: { type: String, required: true },
      email: { type: String, unique: true, lowercase: true, index: true },
      age: Number,
      role: { type: String, enum: ['user', 'admin'], default: 'user' },
      owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
      posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
      tags: [String],
      address: { street: String, city: String },
    }, { timestamps: true, collection: 'people' });

    export const User = mongoose.model('User', userSchema);
  `;

  it('creates a collection with the explicit name and implicit _id / timestamps', () => {
    const r = parse(text);
    expect(r.entities).toHaveLength(1);
    const user = r.entities[0];
    expect(user.kind).toBe('collection');
    expect(user.name).toBe('people');
    expect(user.nameCertainty).toBe(2);
    expect(user.modelName).toBe('User');
    expect(user.engine).toBe('mongodb');
    expect(colNames(user.columns)).toEqual(['_id', 'name', 'email', 'age', 'role', 'owner', 'posts', 'tags', 'address', 'createdAt', 'updatedAt']);
    expect(findCol(user.columns, '_id')).toMatchObject({ type: 'ObjectId', primaryKey: true, nullable: false });
    expect(findCol(user.columns, 'createdAt')).toMatchObject({ type: 'Date', nullable: false });
  });

  it('reads field options: required, unique, default, nested object, arrays', () => {
    const user = parse(text).entities[0];
    expect(findCol(user.columns, 'name')).toMatchObject({ type: 'String', nullable: false });
    expect(findCol(user.columns, 'email')).toMatchObject({ type: 'String', unique: true, nullable: true });
    expect(findCol(user.columns, 'age')).toMatchObject({ type: 'Number' });
    expect(findCol(user.columns, 'tags')).toMatchObject({ type: 'String', isArray: true });
    expect(findCol(user.columns, 'address')).toMatchObject({ type: 'Object' });
  });

  it('emits an inline enum named <collection>_<field> and links it', () => {
    const r = parse(text);
    expect(r.enums).toEqual([expect.objectContaining({ name: 'people_role', values: ['user', 'admin'] })]);
    expect(findCol(r.entities[0].columns, 'role')).toMatchObject({ type: 'String', default: 'user', enumRef: 'people_role' });
  });

  it('turns a single ref into many-to-one and an array of refs into many-to-many', () => {
    const r = parse(text);
    const owner = r.relations.find((x) => x.to.model === 'Account')!;
    expect(owner).toMatchObject({ from: { model: 'User' }, fromColumns: ['owner'], cardinality: 'many-to-one', kind: 'orm' });
    const posts = r.relations.find((x) => x.to.model === 'Post')!;
    expect(posts).toMatchObject({ from: { model: 'User' }, cardinality: 'many-to-many' });
    expect(findCol(r.entities[0].columns, 'owner')).toMatchObject({ type: 'ObjectId' });
    expect(findCol(r.entities[0].columns, 'posts')).toMatchObject({ type: 'ObjectId', isArray: true });
  });

  it('emits a mongodb engine hint', () => {
    expect(parse(text).engines).toEqual([expect.objectContaining({ engine: 'mongodb' })]);
  });
});

describe('mongoose: options and naming', () => {
  it('derives the default collection name from the model name', () => {
    const r = parse(`
      import mongoose from 'mongoose';
      const catSchema = new mongoose.Schema({ name: String });
      export const Cat = mongoose.model('Cat', catSchema);
    `);
    expect(r.entities[0]).toMatchObject({ name: 'cats', nameCertainty: 0, modelName: 'Cat' });
  });

  it('respects _id: false (no implicit primary key)', () => {
    const r = parse(`
      import mongoose from 'mongoose';
      const s = new mongoose.Schema({ key: String }, { _id: false });
      export const Thing = mongoose.model('Thing', s);
    `);
    expect(colNames(r.entities[0].columns)).toEqual(['key']);
  });

  it('derives the model name from the schema variable when there is no model() call', () => {
    const r = parse(`
      import mongoose from 'mongoose';
      export const productSchema = new mongoose.Schema({ title: String });
    `);
    expect(r.entities[0]).toMatchObject({ modelName: 'Product', name: 'products', nameCertainty: 0 });
    expect(r.entities[0].partial).toBeUndefined();
  });

  it('uses the collection from the third model() argument', () => {
    const r = parse(`
      import mongoose from 'mongoose';
      const s = new mongoose.Schema({ a: String });
      export const X = mongoose.model('Widget', s, 'the_widgets');
    `);
    expect(r.entities[0]).toMatchObject({ name: 'the_widgets', nameCertainty: 2 });
  });
});

describe('mongoose: NestJS @Schema / @Prop', () => {
  const text = `
    import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
    import mongoose from 'mongoose';

    @Schema({ collection: 'cats', timestamps: true })
    export class Cat {
      @Prop({ required: true })
      name: string;

      @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Owner' })
      owner: Owner;

      @Prop([String])
      tags: string[];

      @Prop({ default: 0 })
      lives: number;
    }
    export const CatSchema = SchemaFactory.createForClass(Cat);
  `;

  it('parses the decorated class into a collection with props', () => {
    const r = parse(text);
    const cat = r.entities[0];
    expect(cat).toMatchObject({ kind: 'collection', name: 'cats', modelName: 'Cat' });
    expect(colNames(cat.columns)).toEqual(['_id', 'name', 'owner', 'tags', 'lives', 'createdAt', 'updatedAt']);
    expect(findCol(cat.columns, 'name')).toMatchObject({ type: 'String', nullable: false });
    expect(findCol(cat.columns, 'tags')).toMatchObject({ type: 'String', isArray: true });
    expect(findCol(cat.columns, 'lives')).toMatchObject({ type: 'Number', default: '0' });
  });

  it('emits a ref relation from a @Prop ObjectId', () => {
    const r = parse(text);
    expect(r.relations).toEqual([expect.objectContaining({ from: { model: 'Cat', name: 'cats' }, to: { model: 'Owner' }, cardinality: 'many-to-one' })]);
  });
});

describe('mongoose: robustness', () => {
  it('does not throw on malformed / commented-out input', () => {
    for (const text of [
      `import mongoose from 'mongoose'; const s = new mongoose.Schema(`,
      `import mongoose from 'mongoose'; const s = new Schema({ a: });`,
      `// const s = new mongoose.Schema({ a: String });`,
      `const q = "new mongoose.Schema({ not: 'real' })";`,
      '',
      `import mongoose from 'mongoose'; mongoose.model('X');`,
    ]) {
      expect(() => parse(text)).not.toThrow();
    }
  });
});

describe('mongoose: end-to-end via resolveSchema', () => {
  it('links collections, refs and timestamps across a small project', () => {
    const user = `
      import mongoose, { Schema } from 'mongoose';
      const userSchema = new Schema({
        email: { type: String, required: true, unique: true },
        account: { type: Schema.Types.ObjectId, ref: 'Account' },
      }, { timestamps: true });
      export const User = mongoose.model('User', userSchema);
    `;
    const account = `
      import mongoose, { Schema } from 'mongoose';
      const accountSchema = new Schema({ plan: String });
      export const Account = mongoose.model('Account', accountSchema);
    `;
    const schema = resolveSchema([fr(user, 'user.ts'), fr(account, 'account.ts')]);
    expect(schema.entities.map((e) => e.id).sort()).toEqual(['doc:accounts', 'doc:users']);
    const users = schema.entities.find((e) => e.id === 'doc:users')!;
    expect(users.engine).toBe('mongodb');
    expect(colNames(users.columns)).toContain('_id');
    const rel = schema.relations.find((x) => x.from === 'doc:users')!;
    expect(rel).toMatchObject({ to: 'doc:accounts', fromColumns: ['account'], cardinality: 'many-to-one' });
  });

  it('unifies a schema and its model() call declared in different files', () => {
    const schemaFile = `
      import mongoose from 'mongoose';
      export const taskSchema = new mongoose.Schema({ title: String, done: Boolean });
    `;
    const modelFile = `
      import mongoose from 'mongoose';
      import { taskSchema } from './task.schema';
      export const Task = mongoose.model('Task', taskSchema);
    `;
    const schema = resolveSchema([fr(schemaFile, 'task.schema.ts'), fr(modelFile, 'task.model.ts')]);
    expect(schema.entities).toHaveLength(1);
    const task = schema.entities[0];
    expect(task).toMatchObject({ id: 'doc:tasks', modelNames: ['Task'] });
    expect(colNames(task.columns)).toEqual(['_id', 'title', 'done']);
  });

  it('merges discriminators into the base collection (single-table inheritance)', () => {
    const text = `
      import mongoose from 'mongoose';
      const eventSchema = new mongoose.Schema({ at: Date });
      export const Event = mongoose.model('Event', eventSchema);
      const clickSchema = new mongoose.Schema({ url: String });
      export const Click = Event.discriminator('Click', clickSchema);
    `;
    const schema = resolveSchema([fr(text)]);
    expect(schema.entities).toHaveLength(1);
    const ev = schema.entities[0];
    expect(ev.id).toBe('doc:events');
    expect(ev.modelNames.sort()).toEqual(['Click', 'Event']);
    expect(colNames(ev.columns).sort()).toEqual(['_id', 'at', 'url']);
  });
});
