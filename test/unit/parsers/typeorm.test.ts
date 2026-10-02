import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { typeormParser } from '../../../src/parsers/typeorm';

const parse = (path: string, text: string) => typeormParser.parse({ path, text });
const file = (path: string, text: string): FileResult => ({ file: path, kind: 'typeorm', result: parse(path, text) });
const resolve = (...files: FileResult[]) => resolveSchema(files);
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('typeorm detect', () => {
  it('claims TypeORM entity files', () => {
    const text = `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
      @Entity('users') export class User { @PrimaryGeneratedColumn() id: number; @Column() name: string; }`;
    expect(typeormParser.detect({ path: 'user.entity.ts', text })).toBe(true);
  });

  it('rejects neighbours (sequelize-typescript, nestjs/mongoose, mikro-orm) and unrelated code', () => {
    const seq = `import { Table, Column, Model } from 'sequelize-typescript';
      @Table export class User extends Model { @Column name: string; }`;
    const mongoose = `import { Schema, Prop } from '@nestjs/mongoose';
      @Schema() export class Cat { @Prop() name: string; }`;
    const mikro = `import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
      @Entity() export class Book { @PrimaryKey() id: number; @Property() title: string; }`;
    const plain = `export function add(a: number, b: number) { return a + b; }`;
    expect(typeormParser.detect({ path: 'user.model.ts', text: seq })).toBe(false);
    expect(typeormParser.detect({ path: 'cat.schema.ts', text: mongoose })).toBe(false);
    expect(typeormParser.detect({ path: 'book.ts', text: mikro })).toBe(false);
    expect(typeormParser.detect({ path: 'math.ts', text: plain })).toBe(false);
  });
});

const BLOG = `
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, CreateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // the user's login email
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ nullable: true })
  bio: string;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Post, (post) => post.author)
  posts: Post[];
}

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @ManyToOne(() => User, (user) => user.posts, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'author_id' })
  author: User;
}
`;

describe('typeorm columns and relations', () => {
  it('maps entity names, column options and the many-to-one FK end to end', () => {
    const r = resolve(file('src/entities/blog.ts', BLOG));
    expect(r.entities.map((e) => e.id)).toEqual(['post', 'users']);

    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.modelNames).toEqual(['User']);
    expect(names(users.columns)).toEqual(['id', 'email', 'bio', 'createdAt']);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'uuid', primaryKey: true, generated: true, nullable: false });
    expect(users.columns[1]).toMatchObject({ type: 'varchar(255)', unique: true, nullable: false, comment: "the user's login email" });
    expect(users.columns[2]).toMatchObject({ name: 'bio', type: 'string', nullable: true });
    expect(users.columns[3]).toMatchObject({ name: 'createdAt', nullable: false });

    const post = r.entities.find((e) => e.id === 'post')!;
    expect(names(post.columns)).toEqual(['id', 'title', 'author_id']);

    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({
      from: 'post',
      to: 'users',
      fromColumns: ['author_id'],
      toColumns: ['id'],
      cardinality: 'many-to-one',
      optional: false,
      onDelete: 'CASCADE',
      kind: 'orm',
    });
    expect(post.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
  });

  it('resolves @ManyToMany + @JoinTable into a many-to-many relation', () => {
    const text = `
      import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable } from 'typeorm';
      @Entity('posts')
      export class Post {
        @PrimaryGeneratedColumn() id: number;
        @ManyToMany(() => Tag)
        @JoinTable({ name: 'post_tags' })
        tags: Tag[];
      }
      @Entity('tags')
      export class Tag {
        @PrimaryGeneratedColumn() id: number;
        @Column() name: string;
      }`;
    const r = resolve(file('post.entity.ts', text));
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ cardinality: 'many-to-many', throughName: 'post_tags' });
    expect([m2m.from, m2m.to].sort()).toEqual(['posts', 'tags']);
  });
});

describe('typeorm inheritance', () => {
  it('copies abstract base columns into entities and honours @Entity schema/name', () => {
    const text = `
      import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
      export abstract class BaseEntity {
        @PrimaryGeneratedColumn() id: number;
        @CreateDateColumn() createdAt: Date;
      }
      @Entity({ name: 'accounts', schema: 'auth' })
      export class Account extends BaseEntity {
        @Column({ unique: true }) username: string;
      }`;
    const r = resolve(file('account.entity.ts', text));
    const acc = r.entities.find((e) => e.id === 'auth.accounts')!;
    expect(acc).toBeTruthy();
    expect(acc.schema).toBe('auth');
    expect(names(acc.columns)).toEqual(['id', 'createdAt', 'username']);
  });

  it('merges @ChildEntity single-table inheritance into the base table', () => {
    const text = `
      import { Entity, PrimaryGeneratedColumn, Column, TableInheritance, ChildEntity } from 'typeorm';
      @Entity('content')
      @TableInheritance({ column: { type: 'varchar', name: 'type' } })
      export class Content {
        @PrimaryGeneratedColumn() id: number;
        @Column() title: string;
      }
      @ChildEntity()
      export class Article extends Content {
        @Column() body: string;
      }`;
    const r = resolve(file('content.entity.ts', text));
    expect(r.entities.map((e) => e.id)).toEqual(['content']);
    const content = r.entities[0];
    expect(names(content.columns)).toEqual(['id', 'title', 'body']);
    expect(content.modelNames.sort()).toEqual(['Article', 'Content']);
  });
});

describe('typeorm EntitySchema', () => {
  it('reads the new EntitySchema({ … }) form', () => {
    const text = `
      import { EntitySchema } from 'typeorm';
      export const CategorySchema = new EntitySchema({
        name: 'Category',
        tableName: 'categories',
        columns: {
          id: { type: Number, primary: true, generated: true },
          name: { type: String, unique: true },
        },
      });`;
    const r = resolve(file('category.ts', text));
    const cat = r.entities.find((e) => e.id === 'categories')!;
    expect(cat.modelNames).toEqual(['Category']);
    expect(names(cat.columns)).toEqual(['id', 'name']);
    expect(cat.columns[0]).toMatchObject({ type: 'int', primaryKey: true, generated: true });
    expect(cat.columns[1]).toMatchObject({ type: 'varchar', unique: true });
  });
});

describe('typeorm robustness', () => {
  it('does not throw on malformed / commented-out input and ignores look-alike strings', () => {
    const text = `
      import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
      // @Entity('ghost') export class Ghost { @Column() x: string; }
      const sql = "@Entity('fake') class Fake {}";
      @Entity('widgets'
      export class Widget {
        @PrimaryGeneratedColumn() id: number;
        @Column({ nullable: true }) label: string;
    `;
    expect(() => parse('widget.entity.ts', text)).not.toThrow();
    const r = parse('widget.entity.ts', text);
    expect(r.entities.every((e) => e.name !== 'ghost' && e.name !== 'fake')).toBe(true);
  });
});
