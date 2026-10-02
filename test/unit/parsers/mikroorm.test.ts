import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { mikroormParser } from '../../../src/parsers/mikroorm';

const parse = (path: string, text: string) => mikroormParser.parse({ path, text });
const file = (path: string, text: string): FileResult => ({ file: path, kind: 'mikroorm', result: parse(path, text) });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('mikroorm detect', () => {
  it('claims MikroORM entities and rejects neighbours', () => {
    const mikro = `import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
      @Entity() export class Book { @PrimaryKey() id!: number; @Property() title!: string; }`;
    const typeorm = `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
      @Entity() export class User { @PrimaryGeneratedColumn() id!: number; @Column() name!: string; }`;
    expect(mikroormParser.detect({ path: 'book.ts', text: mikro })).toBe(true);
    expect(mikroormParser.detect({ path: 'user.ts', text: typeorm })).toBe(false);
    expect(mikroormParser.detect({ path: 'x.ts', text: 'export const a = 1;' })).toBe(false);
  });
});

const LIB = `
import { Entity, PrimaryKey, Property, ManyToOne, OneToMany, Collection } from '@mikro-orm/core';

export abstract class BaseEntity {
  @PrimaryKey()
  id!: number;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}

@Entity({ tableName: 'authors' })
export class Author extends BaseEntity {
  @Property({ unique: true })
  email!: string;

  @Property({ nullable: true })
  name?: string;

  @OneToMany(() => Book, (book) => book.author)
  books = new Collection<Book>(this);
}

@Entity()
export class Book {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @ManyToOne(() => Author, { deleteRule: 'cascade', nullable: false })
  author!: Author;
}
`;

describe('mikroorm columns and relations', () => {
  it('applies UnderscoreNamingStrategy, inherits base columns and builds the FK', () => {
    const r = resolveSchema([file('src/entities.ts', LIB)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['authors', 'book']);

    const authors = r.entities.find((e) => e.id === 'authors')!;
    expect(authors.modelNames).toEqual(['Author']);
    expect(names(authors.columns)).toEqual(['id', 'created_at', 'email', 'name']);
    expect(authors.columns[0]).toMatchObject({ name: 'id', primaryKey: true, generated: true, nullable: false });
    expect(authors.columns.find((c) => c.name === 'email')).toMatchObject({ unique: true, nullable: false, type: 'string' });
    expect(authors.columns.find((c) => c.name === 'name')).toMatchObject({ nullable: true });

    const book = r.entities.find((e) => e.id === 'book')!;
    expect(names(book.columns)).toEqual(['id', 'title', 'author_id']);

    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({
      from: 'book',
      to: 'authors',
      fromColumns: ['author_id'],
      toColumns: ['id'],
      cardinality: 'many-to-one',
      optional: false,
      onDelete: 'cascade',
    });
    expect(book.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'authors', column: 'id' });
  });

  it('reads inline @Enum items and @ManyToMany pivot tables', () => {
    const text = `
      import { Entity, PrimaryKey, Property, Enum, ManyToMany, Collection } from '@mikro-orm/core';
      @Entity({ tableName: 'posts' })
      export class Post {
        @PrimaryKey() id!: number;
        @Enum({ items: ['draft', 'published'] }) status!: string;
        @ManyToMany({ entity: () => Tag, owner: true, pivotTable: 'post_tags' })
        tags = new Collection<Tag>(this);
      }
      @Entity({ tableName: 'tags' })
      export class Tag {
        @PrimaryKey() id!: number;
        @Property() label!: string;
      }`;
    const r = resolveSchema([file('post.ts', text)]);
    const post = r.entities.find((e) => e.id === 'posts')!;
    const status = post.columns.find((c) => c.name === 'status')!;
    expect(status.enumRef).toBeTruthy();
    expect(r.enums.find((e) => e.id === status.enumRef)!.values).toEqual(['draft', 'published']);
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ throughName: 'post_tags' });
    expect([m2m.from, m2m.to].sort()).toEqual(['posts', 'tags']);
  });

  it('reads the EntitySchema form and never throws on malformed input', () => {
    const es = `
      import { EntitySchema } from '@mikro-orm/core';
      export const UserSchema = new EntitySchema({
        name: 'User',
        tableName: 'users',
        properties: {
          id: { type: 'number', primary: true },
          firstName: { type: 'string', fieldName: 'first_name' },
        },
      });`;
    const r = resolveSchema([file('user.ts', es)]);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(names(users.columns)).toEqual(['id', 'first_name']);
    expect(() => parse('broken.ts', '@Entity({ tableName: "x" export class X { @PrimaryKey() id')).not.toThrow();
  });
});
