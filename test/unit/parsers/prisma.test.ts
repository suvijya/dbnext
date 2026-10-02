import { describe, expect, it } from 'vitest';
import type { Column, FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { prismaParser } from '../../../src/parsers/prisma';

const parse = (text: string, path = 'schema.prisma') => prismaParser.parse({ path, text });
const fr = (text: string, path = 'schema.prisma'): FileResult => ({ file: path, kind: 'prisma', result: parse(text, path) });
const colNames = (cols: Column[]) => cols.map((c) => c.name);
const findCol = (cols: Column[], name: string) => cols.find((c) => c.name === name);

describe('prisma: detect', () => {
  it('matches real prisma schemas', () => {
    expect(prismaParser.detect({ path: 'schema.prisma', text: 'model User {\n id Int @id\n}' })).toBe(true);
    expect(prismaParser.detect({ path: 'x.prisma', text: 'datasource db {\n provider = "postgresql"\n}' })).toBe(true);
    expect(prismaParser.detect({ path: 'x.prisma', text: 'enum Role {\n USER\n}' })).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(prismaParser.detect({ path: 'x.prisma', text: '// just a comment' })).toBe(false);
    expect(prismaParser.detect({ path: 'x.prisma', text: 'const x = pgTable("users", {});' })).toBe(false);
  });
});

describe('prisma: models and columns', () => {
  const text = `
    datasource db {
      provider = "postgresql"
      url      = env("DATABASE_URL")
    }
    generator client {
      provider = "prisma-client-js"
    }

    /// A registered account.
    model User {
      id        Int      @id @default(autoincrement())
      email     String   @unique @db.VarChar(255)
      name      String?
      role      Role     @default(USER)
      bio       String?  @map("biography")
      createdAt DateTime @default(now()) @map("created_at")
      updatedAt DateTime @updatedAt
      tags      String[]
      posts     Post[]
      @@map("users")
      @@index([email])
    }

    model Post {
      id       Int    @id @default(autoincrement())
      title    String
      author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
      authorId Int    @map("author_id")
    }

    enum Role {
      USER
      ADMIN @map("admin")
      @@map("roles")
    }
  `;

  it('reads table name from @@map with certainty 2 and keeps the model name', () => {
    const r = parse(text);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user.name).toBe('users');
    expect(user.nameCertainty).toBe(2);
    expect(user.kind).toBe('table');
    expect(user.comment).toBe('A registered account.');
  });

  it('derives table name from the model name (certainty 0) when no @@map', () => {
    const r = parse(text);
    const post = r.entities.find((e) => e.modelName === 'Post')!;
    expect(post.name).toBe('Post');
    expect(post.nameCertainty).toBe(0);
  });

  it('applies @map, @db native types, @default and modifiers to columns', () => {
    const r = parse(text);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(colNames(user.columns)).toEqual(['id', 'email', 'name', 'role', 'biography', 'created_at', 'updatedAt', 'tags']);
    expect(findCol(user.columns, 'id')).toMatchObject({ primaryKey: true, nullable: false, generated: true, type: 'Int' });
    expect(findCol(user.columns, 'email')).toMatchObject({ unique: true, type: 'VarChar(255)', nullable: false });
    expect(findCol(user.columns, 'name')).toMatchObject({ nullable: true });
    expect(findCol(user.columns, 'created_at')).toMatchObject({ generated: true, default: 'now()' });
    expect(findCol(user.columns, 'updatedAt')).toMatchObject({ generated: true });
    expect(findCol(user.columns, 'tags')).toMatchObject({ isArray: true, type: 'String', nullable: false });
  });

  it('does not emit relation fields (lists / objects) as columns', () => {
    const r = parse(text);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(findCol(user.columns, 'posts')).toBeUndefined();
    const post = r.entities.find((e) => e.modelName === 'Post')!;
    expect(findCol(post.columns, 'author')).toBeUndefined();
    expect(colNames(post.columns)).toEqual(['id', 'title', 'author_id']);
  });

  it('emits a postgres engine hint', () => {
    const r = parse(text);
    expect(r.engines).toEqual([expect.objectContaining({ engine: 'postgresql', detail: 'datasource provider "postgresql"' })]);
  });

  it('maps enums with @map values and @@map name, and links the enum column', () => {
    const r = parse(text);
    expect(r.enums).toEqual([expect.objectContaining({ name: 'roles', values: ['USER', 'admin'] })]);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(findCol(user.columns, 'role')).toMatchObject({ type: 'Role', enumRef: 'roles', default: 'USER' });
  });
});

describe('prisma: relations', () => {
  it('emits a many-to-one from the @relation(fields) owner using mapped FK columns', () => {
    const r = parse(`
      model User { id Int @id posts Post[] }
      model Post {
        id       Int  @id
        author   User @relation(fields: [authorId], references: [id], onDelete: Cascade)
        authorId Int  @map("author_id")
      }
    `);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({
      from: { model: 'Post' },
      fromColumns: ['author_id'],
      to: { model: 'User' },
      toColumns: ['id'],
      cardinality: 'many-to-one',
      kind: 'orm',
      onDelete: 'Cascade',
    });
  });

  it('detects one-to-one when the FK field is @unique', () => {
    const r = parse(`
      model User { id Int @id profile Profile? }
      model Profile {
        id     Int  @id
        user   User @relation(fields: [userId], references: [id])
        userId Int  @unique
      }
    `);
    expect(r.relations[0]).toMatchObject({ from: { model: 'Profile' }, to: { model: 'User' }, cardinality: 'one-to-one' });
  });

  it('emits implicit many-to-many once with the _AToB through name', () => {
    const r = parse(`
      model Post {
        id         Int        @id
        categories Category[]
      }
      model Category {
        id    Int    @id
        posts Post[]
      }
    `);
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    expect(m2m).toHaveLength(1);
    expect(m2m[0]).toMatchObject({ from: { model: 'Category' }, to: { model: 'Post' }, through: { name: '_CategoryToPost' } });
  });

  it('uses the named relation for the implicit m2m through name', () => {
    const r = parse(`
      model Post {
        id   Int   @id
        tags Tag[] @relation("PostTags")
      }
      model Tag {
        id    Int    @id
        posts Post[] @relation("PostTags")
      }
    `);
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    expect(m2m).toHaveLength(1);
    expect(m2m[0].through).toMatchObject({ name: '_PostTags' });
  });
});

describe('prisma: views, composite types, mongodb', () => {
  it('treats view blocks as views and skips composite types', () => {
    const r = parse(`
      view ActiveUser {
        id    Int    @unique
        email String
      }
      type Address {
        street String
        city   String
      }
      model Company {
        id      Int     @id
        address Address
        name    String
      }
    `);
    expect(r.entities.find((e) => e.modelName === 'ActiveUser')!.kind).toBe('view');
    expect(r.entities.some((e) => e.modelName === 'Address')).toBe(false);
    // composite-typed field becomes a plain column, not a relation
    const company = r.entities.find((e) => e.modelName === 'Company')!;
    expect(findCol(company.columns, 'address')).toMatchObject({ type: 'Address' });
  });

  it('treats models as collections for a mongodb datasource and ObjectId ids', () => {
    const r = parse(`
      datasource db { provider = "mongodb" }
      model User {
        id    String @id @default(auto()) @map("_id") @db.ObjectId
        email String @unique
      }
    `);
    expect(r.engines).toEqual([expect.objectContaining({ engine: 'mongodb' })]);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user.kind).toBe('collection');
    expect(findCol(user.columns, '_id')).toMatchObject({ primaryKey: true, type: 'ObjectId', generated: true });
  });
});

describe('prisma: robustness', () => {
  it('does not throw on malformed / commented-out input', () => {
    for (const text of [
      'model {',
      'model User { id Int @id',
      'model User {\n // posts Post[]\n id Int @id\n}',
      'enum {}',
      'model A { b B @relation(fields: [cId], references: [',
      '',
      'random text without a schema',
    ]) {
      expect(() => parse(text)).not.toThrow();
    }
  });

  it('ignores commented-out fields and @@ignore models', () => {
    const r = parse(`
      model User {
        id   Int @id
        // secret String
        name String
      }
      model Legacy {
        id Int @id
        @@ignore
      }
    `);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(colNames(user.columns)).toEqual(['id', 'name']);
    expect(r.entities.some((e) => e.modelName === 'Legacy')).toBe(false);
  });
});

describe('prisma: end-to-end via resolveSchema', () => {
  it('builds the expected entities, columns and relations a user would see', () => {
    const text = `
      datasource db { provider = "postgresql" }
      model User {
        id    Int     @id @default(autoincrement())
        email String  @unique
        posts Post[]
        role  Role    @default(USER)
      }
      model Post {
        id       Int    @id @default(autoincrement())
        title    String
        author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
        authorId Int
        tags     Tag[]
      }
      model Tag {
        id    Int    @id
        name  String @unique
        posts Post[]
      }
      enum Role {
        USER
        ADMIN
      }
    `;
    const schema = resolveSchema([fr(text)]);

    expect(schema.entities.map((e) => e.id).sort()).toEqual(['post', 'tag', 'user']);

    const user = schema.entities.find((e) => e.id === 'user')!;
    expect(user.engine).toBe('postgresql');
    expect(findCol(user.columns, 'role')!.enumRef).toBe('role');

    const fk = schema.relations.find((x) => x.cardinality === 'many-to-one')!;
    expect(fk).toMatchObject({ from: 'post', to: 'user', fromColumns: ['authorId'], toColumns: ['id'], kind: 'orm', optional: false });

    const m2m = schema.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: 'post', to: 'tag', throughName: '_PostToTag' });

    expect(schema.enums).toEqual([expect.objectContaining({ id: 'role', values: ['USER', 'ADMIN'] })]);
  });

  it('parses multi-file schemas per file and still links them', () => {
    const userFile = `
      model User {
        id    Int    @id
        posts Post[]
      }
    `;
    const postFile = `
      model Post {
        id       Int  @id
        author   User @relation(fields: [authorId], references: [id])
        authorId Int
      }
    `;
    const schema = resolveSchema([fr(userFile, 'prisma/user.prisma'), fr(postFile, 'prisma/post.prisma')]);
    expect(schema.entities.map((e) => e.id).sort()).toEqual(['post', 'user']);
    expect(schema.relations.find((x) => x.cardinality === 'many-to-one')).toMatchObject({ from: 'post', to: 'user' });
  });
});
