import { describe, expect, it } from 'vitest';
import type { Column, FileResult, ParseResult, RawEntity, RawRelation, SchemaOp, SourceKind } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { buildModel, compareMigrationPaths, orderMigrations, resolveSchema } from '../../src/core/resolve';

const src = (file: string, line = 0) => ({ file, line });
const pk = (name = 'id', type = 'int') => column(name, type, { primaryKey: true, nullable: false });
const col = (name: string, type = 'text', props: Partial<Column> = {}) => column(name, type, props);

function table(file: string, name: string, columns: Column[], extra: Partial<RawEntity> = {}, line = 0): RawEntity {
  return { name, kind: 'table', columns, source: src(file, line), ...extra };
}

function rel(
  file: string,
  from: string | RawRelation['from'],
  fromColumns: string[],
  to: string | RawRelation['to'],
  toColumns: string[] = [],
  extra: Partial<RawRelation> = {},
  line = 0,
): RawRelation {
  return {
    from: typeof from === 'string' ? { name: from } : from,
    fromColumns,
    to: typeof to === 'string' ? { name: to } : to,
    toColumns,
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    source: src(file, line),
    ...extra,
  };
}

function result(path: string, kind: SourceKind, r: Partial<ParseResult>): FileResult {
  return { file: path, kind, result: { entities: [], relations: [], enums: [], ...r } };
}

const names = (cols: Column[]) => cols.map((c) => c.name);

describe('definitions', () => {
  it('links foreign keys, defaults target columns to the primary key and marks referencing columns', () => {
    const f = 'schema.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [
          table(f, 'users', [pk(), col('email', 'text', { nullable: false, unique: true })]),
          table(f, 'posts', [pk(), col('author_id', 'int', { nullable: false }), col('editor_id', 'int')], {}, 5),
        ],
        relations: [rel(f, 'posts', ['author_id'], 'users', ['id'], {}, 7), rel(f, 'posts', ['editor_id'], 'users', [], {}, 8)],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['posts', 'users']);
    expect(r.relations).toHaveLength(2);
    const author = r.relations.find((x) => x.fromColumns[0] === 'author_id')!;
    expect(author).toMatchObject({ from: 'posts', to: 'users', toColumns: ['id'], cardinality: 'many-to-one', optional: false, kind: 'foreign-key' });
    const editor = r.relations.find((x) => x.fromColumns[0] === 'editor_id')!;
    expect(editor).toMatchObject({ toColumns: ['id'], optional: true });
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
    expect(posts.source).toEqual({ file: f, line: 5 });
  });

  it('keeps tables and document collections apart', () => {
    const r = resolveSchema([
      result('a.sql', 'sql', { entities: [table('a.sql', 'users', [pk()])] }),
      result('user.js', 'mongoose', {
        entities: [{ name: 'users', kind: 'collection', modelName: 'User', columns: [pk('_id', 'ObjectId')], source: src('user.js') }],
      }),
    ]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['doc:users', 'users']);
  });

  it('handles schemas: default schemas are omitted, unqualified names resolve like search_path, unique names across schemas', () => {
    const f = 'db.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [
          table(f, 'users', [pk()], { schema: 'public' }),
          table(f, 'users', [pk('id', 'uuid')], { schema: 'auth' }),
          table(f, 'sessions', [pk(), col('user_id', 'uuid')], { schema: 'auth' }),
          table(f, 'profiles', [pk(), col('auth_user_id', 'uuid'), col('session_id', 'int')]),
        ],
        relations: [
          rel(f, { name: 'sessions', schema: 'auth' }, ['user_id'], 'users'),
          rel(f, 'profiles', ['auth_user_id'], { name: 'users', schema: 'auth' }),
          rel(f, 'profiles', ['session_id'], 'sessions'),
        ],
      }),
    ]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['auth.sessions', 'auth.users', 'profiles', 'users']);
    expect(r.relations.map((x) => `${x.from}>${x.to}`).sort()).toEqual(['auth.sessions>users', 'profiles>auth.sessions', 'profiles>auth.users']);
    expect(r.entities.find((e) => e.id === 'users')!.schema).toBeUndefined();
  });

  it('merges definitions of the same table from several files (first source wins, gaps are filled)', () => {
    const r = resolveSchema([
      result('b/model.py', 'sqlalchemy', {
        entities: [table('b/model.py', 'users', [pk(), col('email', 'String', { comment: 'login' }), col('bio', 'Text')], { modelName: 'User' })],
      }),
      result('a/schema.sql', 'sql', { entities: [table('a/schema.sql', 'users', [pk('id', 'serial'), col('email', '')])] }),
    ]);
    const users = r.entities[0];
    expect(names(users.columns)).toEqual(['id', 'email', 'bio']);
    expect(users.columns[0].type).toBe('serial'); // SQL ranks first
    expect(users.columns[1]).toMatchObject({ type: 'String', comment: 'login' });
    expect(users.sources).toEqual(['sql', 'sqlalchemy']);
    expect(users.source?.file).toBe('b/model.py'); // ORM model preferred for "Go to definition"
    expect(users.modelNames).toEqual(['User']);
  });

  it('scopes destructive ops in definition files to the file itself and defers cross-file alters', () => {
    const r = resolveSchema([
      result('db/schema.sql', 'sql', {
        entities: [table('db/schema.sql', 'users', [col('id', 'int'), col('email')], {}, 1)],
        ops: [{ op: 'dropTable', table: { name: 'users' }, source: src('db/schema.sql', 0) }],
      }),
      result('db/reset.sql', 'sql', { ops: [{ op: 'dropTable', table: { name: 'users' }, source: src('db/reset.sql') }] }),
      result('db/constraints.sql', 'sql', {
        ops: [{ op: 'alterColumn', table: { name: 'users' }, column: 'id', set: { primaryKey: true }, source: src('db/constraints.sql') }],
      }),
    ]);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].columns[0]).toMatchObject({ name: 'id', primaryKey: true, nullable: false });
  });

  it('applies fluent column mapping from another definition file (EF Core DbContext)', () => {
    const ctx = 'Data/AppDbContext.cs';
    const r = resolveSchema([
      result(ctx, 'efcore', {
        entities: [table(ctx, 'Blogs', [], { modelName: 'Blog', nameCertainty: 1, partial: true }, 4)],
        relations: [rel(ctx, { model: 'Post' }, ['BlogId'], { model: 'Blog' }, [], { kind: 'orm' }, 12)],
        ops: [
          { op: 'alterColumn', table: { model: 'Blog' }, column: 'Url', set: { nullable: false }, source: src(ctx, 9) },
          { op: 'renameColumn', table: { model: 'Blog' }, column: 'Url', to: 'blog_url', source: src(ctx, 10) },
          { op: 'renameColumn', table: { model: 'Post' }, column: 'BlogId', to: 'blog_id', source: src(ctx, 11) },
        ],
      }),
      result('Models/Blog.cs', 'efcore', {
        entities: [table('Models/Blog.cs', 'Blog', [pk('Id'), col('Url', 'string')], { modelName: 'Blog', nameCertainty: 0 }, 2)],
      }),
      result('Models/Post.cs', 'efcore', {
        entities: [table('Models/Post.cs', 'Post', [pk('Id'), col('BlogId', 'int')], { modelName: 'Post', nameCertainty: 0 }, 2)],
      }),
    ]);
    const blogs = r.entities.find((e) => e.id === 'blogs')!;
    expect(names(blogs.columns)).toEqual(['Id', 'blog_url']);
    expect(blogs.columns[1]).toMatchObject({ type: 'string', nullable: false });
    expect(r.entities.find((e) => e.id === 'post')!.columns.map((c) => c.name)).toEqual(['Id', 'blog_id']);
    expect(r.relations).toEqual([expect.objectContaining({ from: 'post', fromColumns: ['blog_id'], to: 'blogs' })]);
  });

  it('drops column-less partial entities that nothing references (index / comment on unknown tables)', () => {
    const f = 'db/extra.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [
          table(f, 'users', [pk()]),
          table(f, 'ghost', [], { partial: true, indexes: [{ columns: ['x'], unique: false }] }, 3),
          table(f, 'ghost_comment', [], { partial: true, comment: 'hi' }, 4),
          table(f, 'audit_log', [col('user_id', 'int')], { partial: true }, 5),
        ],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['audit_log', 'users']);
  });
});

describe('migration replay', () => {
  it('applies add / rename / drop / alter in chronological order regardless of input order', () => {
    const f1 = 'db/migrate/001_init.sql';
    const f2 = 'db/migrate/002_change.sql';
    const ops: SchemaOp[] = [
      { op: 'renameColumn', table: { name: 'users' }, column: 'name', to: 'full_name', source: src(f2, 1) },
      { op: 'renameTable', table: { name: 'users' }, to: 'members', source: src(f2, 2) },
      { op: 'dropColumn', table: { name: 'posts' }, column: 'body', source: src(f2, 3) },
      { op: 'dropTable', table: { name: 'legacy' }, source: src(f2, 4) },
      { op: 'alterColumn', table: { name: 'members' }, column: 'email', set: { nullable: false, unique: true }, source: src(f2, 5) },
    ];
    const m1 = result(f1, 'sql', {
      origin: 'migration',
      entities: [
        table(f1, 'users', [pk(), col('name')]),
        table(f1, 'posts', [pk(), col('user_id', 'int'), col('body')], {}, 3),
        table(f1, 'legacy', [pk()], {}, 6),
      ],
      relations: [rel(f1, 'posts', ['user_id'], 'users', ['id'], {}, 4)],
    });
    const m2 = result(f2, 'sql', { origin: 'migration', entities: [table(f2, 'users', [col('email')], { partial: true })], ops });
    const r = resolveSchema([m2, m1]);
    expect(r.entities.map((e) => e.id)).toEqual(['members', 'posts']);
    expect(names(r.entities[0].columns)).toEqual(['id', 'full_name', 'email']);
    expect(r.entities[0].columns[2]).toMatchObject({ nullable: false, unique: true });
    expect(names(r.entities[1].columns)).toEqual(['id', 'user_id']);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ from: 'posts', to: 'members', fromColumns: ['user_id'] });
  });

  it('handles the SQLite "redefine table" pattern (create new_x, drop x, rename new_x to x)', () => {
    const f1 = 'prisma/migrations/20240101000000_init/migration.sql';
    const f2 = 'prisma/migrations/20240202000000_redefine/migration.sql';
    const r = resolveSchema([
      result(f1, 'sql', {
        origin: 'migration',
        entities: [
          table(f1, 'users', [pk()]),
          table(f1, 'posts', [pk(), col('author_id', 'int', { nullable: false })], {}, 2),
          table(f1, 'comments', [pk(), col('post_id', 'int', { nullable: false })], {}, 4),
        ],
        relations: [rel(f1, 'posts', ['author_id'], 'users', ['id'], {}, 3), rel(f1, 'comments', ['post_id'], 'posts', ['id'], {}, 5)],
      }),
      result(f2, 'sql', {
        origin: 'migration',
        entities: [table(f2, 'new_posts', [pk(), col('author_id', 'int', { nullable: false }), col('title')])],
        relations: [rel(f2, 'new_posts', ['author_id'], 'users', ['id'], {}, 1)],
        ops: [
          { op: 'dropTable', table: { name: 'posts' }, source: src(f2, 3) },
          { op: 'renameTable', table: { name: 'new_posts' }, to: 'posts', source: src(f2, 4) },
        ],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['comments', 'posts', 'users']);
    expect(names(r.entities[1].columns)).toEqual(['id', 'author_id', 'title']);
    expect(r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}`)).toEqual(['comments.post_id>posts', 'posts.author_id>users']);
  });

  it('drops foreign keys by name, default name, columns or target', () => {
    const f1 = 'm/001.sql';
    const f2 = 'm/002.sql';
    const r = resolveSchema(
      [
        result(f1, 'sql', {
          origin: 'migration',
          entities: [
            table(f1, 'users', [pk()]),
            table(f1, 'posts', [pk(), col('author_id', 'int'), col('editor_id', 'int')]),
            table(f1, 'comments', [pk(), col('post_id', 'int'), col('user_id', 'int')]),
          ],
          relations: [
            rel(f1, 'posts', ['author_id'], 'users'),
            rel(f1, 'posts', ['editor_id'], 'users', [], { name: 'fk_editor' }),
            rel(f1, 'comments', ['post_id'], 'posts'),
            rel(f1, 'comments', ['user_id'], 'users'),
          ],
        }),
        result(f2, 'sql', {
          origin: 'migration',
          ops: [
            { op: 'dropForeignKey', table: { name: 'posts' }, name: 'posts_author_id_fkey', source: src(f2, 0) },
            { op: 'dropForeignKey', table: { name: 'posts' }, name: 'FK_EDITOR', source: src(f2, 1) },
            { op: 'dropForeignKey', table: { name: 'comments' }, columns: ['post_id'], source: src(f2, 2) },
            { op: 'dropForeignKey', table: { name: 'comments' }, to: { name: 'users' }, source: src(f2, 3) },
          ],
        }),
      ],
      { inferRelations: false },
    );
    expect(r.relations).toEqual([]);
  });

  it('orders Flyway versions numerically and repeatable migrations last', () => {
    const files = ['V10__x.sql', 'V1_1__b.sql', 'V1__a.sql', 'R__views.sql', 'V1.2__c.sql', 'V2__d.sql'].map((f) => `db/migration/${f}`);
    expect([...files].sort(compareMigrationPaths).map((f) => f.slice(13))).toEqual([
      'V1__a.sql',
      'V1_1__b.sql',
      'V1.2__c.sql',
      'V2__d.sql',
      'V10__x.sql',
      'R__views.sql',
    ]);
  });

  it('orders migrations with an explicit revision graph (Alembic) topologically', () => {
    const mk = (file: string, migration?: { id: string; after: string[] }) => ({ file, result: { entities: [], relations: [], enums: [], migration } });
    const ordered = orderMigrations([
      mk('alembic/versions/aaa_third.py', { id: 'aaa', after: ['ccc'] }),
      mk('alembic/versions/bbb_first.py', { id: 'bbb', after: [] }),
      mk('alembic/versions/ccc_second.py', { id: 'ccc', after: ['bbb'] }),
      mk('sql/0001_other.sql'),
    ]);
    expect(ordered.map((m) => m.file)).toEqual([
      'alembic/versions/bbb_first.py',
      'alembic/versions/ccc_second.py',
      'alembic/versions/aaa_third.py',
      'sql/0001_other.sql',
    ]);
  });
});

describe('definitions vs migrations', () => {
  it('prefers current definitions over the migration history and fills missing details', () => {
    const p = 'prisma/schema.prisma';
    const m = 'prisma/migrations/1_init/migration.sql';
    const r = resolveSchema([
      result(m, 'sql', {
        origin: 'migration',
        entities: [table(m, 'User', [pk('id', 'SERIAL'), col('email', 'TEXT', { nullable: false }), col('old_col', 'TEXT')])],
      }),
      result(p, 'prisma', {
        entities: [table(p, 'User', [pk('id', 'Int'), col('email', '', { nullable: false })], { modelName: 'User' }, 10)],
      }),
    ]);
    const user = r.entities[0];
    expect(names(user.columns)).toEqual(['id', 'email']);
    expect(user.columns.map((c) => c.type)).toEqual(['Int', 'TEXT']);
    expect(user.sources).toEqual(['prisma', 'sql']);
    expect(user.source).toEqual({ file: p, line: 10 });
  });

  it('uses migration columns for ORM models without columns and merges both sides of an association', () => {
    const mig = 'db/migrate/20240101_create.rb';
    const r = resolveSchema([
      result(mig, 'rails', {
        origin: 'migration',
        entities: [table(mig, 'users', [pk(), col('name', 'string')]), table(mig, 'posts', [pk(), col('user_id', 'bigint', { nullable: false }), col('title', 'string')])],
      }),
      result('app/models/user.rb', 'rails', {
        entities: [table('app/models/user.rb', 'users', [], { modelName: 'User', nameCertainty: 0 })],
        relations: [
          rel('app/models/user.rb', { model: 'User' }, [], { model: 'Post' }, ['user_id'], { cardinality: 'one-to-many', kind: 'orm' }, 2),
        ],
      }),
      result('app/models/post.rb', 'rails', {
        entities: [table('app/models/post.rb', 'posts', [], { modelName: 'Post', nameCertainty: 0 })],
        relations: [rel('app/models/post.rb', { model: 'Post' }, ['user_id'], { model: 'User' }, [], { kind: 'orm' }, 2)],
      }),
    ]);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(names(posts.columns)).toEqual(['id', 'user_id', 'title']);
    expect(posts.source?.file).toBe('app/models/post.rb');
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ from: 'posts', fromColumns: ['user_id'], to: 'users', toColumns: ['id'], kind: 'orm', optional: false });
  });

  it('ignores migration foreign keys whose columns no longer exist in the definition', () => {
    const m = 'migrations/001.sql';
    const r = resolveSchema(
      [
        result(m, 'sql', {
          origin: 'migration',
          entities: [table(m, 'users', [pk()]), table(m, 'posts', [pk(), col('owner_id', 'int')])],
          relations: [rel(m, 'posts', ['owner_id'], 'users')],
        }),
        result('entities/post.ts', 'typeorm', {
          entities: [table('entities/post.ts', 'posts', [pk(), col('title')], { modelName: 'Post' })],
        }),
      ],
      { inferRelations: false },
    );
    expect(r.relations).toEqual([]);
  });
});

describe('ORM modelling', () => {
  it('unifies ORM table names by certainty, confirms candidates and inherits candidate bases', () => {
    const r = resolveSchema([
      result('Models/Blog.cs', 'efcore', {
        entities: [
          table('Models/Blog.cs', 'Blog', [pk('Id'), col('Url', 'string')], { modelName: 'Blog', nameCertainty: 0, candidate: true, extends: ['BaseEntity'] }),
        ],
        relations: [rel('Models/Blog.cs', { model: 'Blog' }, [], { model: 'Post' }, [], { cardinality: 'one-to-many', kind: 'orm' }, 3)],
      }),
      result('Models/Post.cs', 'efcore', {
        entities: [table('Models/Post.cs', 'Post', [pk('Id'), col('BlogId', 'int', { nullable: false }), col('Title', 'string')], { modelName: 'Post', nameCertainty: 0, candidate: true })],
        relations: [rel('Models/Post.cs', { model: 'Post' }, ['BlogId'], { model: 'Blog' }, [], { kind: 'orm' }, 4)],
      }),
      result('Models/BaseEntity.cs', 'efcore', {
        entities: [table('Models/BaseEntity.cs', 'BaseEntity', [col('CreatedAt', 'DateTime', { nullable: false })], { modelName: 'BaseEntity', nameCertainty: 0, candidate: true })],
      }),
      result('Models/UserDto.cs', 'efcore', {
        entities: [table('Models/UserDto.cs', 'UserDto', [col('BlogId', 'int')], { modelName: 'UserDto', nameCertainty: 0, candidate: true })],
        relations: [rel('Models/UserDto.cs', { model: 'UserDto' }, ['BlogId'], { model: 'Blog' }, [], { kind: 'orm' })],
      }),
      result('Data/AppDbContext.cs', 'efcore', {
        entities: [
          table('Data/AppDbContext.cs', 'Blogs', [], { modelName: 'Blog', nameCertainty: 1 }, 5),
          table('Data/AppDbContext.cs', 'blog_posts', [], { modelName: 'Post', nameCertainty: 2, partial: true }, 9),
        ],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['blog_posts', 'blogs']);
    const blogs = r.entities[1];
    expect(names(blogs.columns)).toEqual(['CreatedAt', 'Id', 'Url']);
    expect(blogs.source?.file).toBe('Models/Blog.cs');
    expect(names(r.entities[0].columns)).toEqual(['Id', 'BlogId', 'Title']);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ from: 'blog_posts', fromColumns: ['BlogId'], to: 'blogs', toColumns: ['Id'] });
  });

  it('copies columns and relations of abstract bases into every concrete model', () => {
    const f = 'blog/models.py';
    const r = resolveSchema([
      result(f, 'django', {
        entities: [
          table(f, 'blog_timestamped', [col('created_at', 'DateTimeField'), col('created_by_id', 'ForeignKey')], { modelName: 'Timestamped', abstract: true }),
          table(f, 'blog_article', [pk(), col('title', 'CharField')], { modelName: 'Article', extends: ['Timestamped'] }, 5),
          table(f, 'blog_comment', [pk(), col('text', 'TextField')], { modelName: 'Comment', extends: ['Timestamped'] }, 9),
        ],
        relations: [rel(f, { model: 'Timestamped' }, ['created_by_id'], { name: 'auth_user', model: 'User' }, [], { kind: 'orm' }, 2)],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['blog_article', 'blog_comment', 'auth_user']);
    expect(names(r.entities[0].columns)).toEqual(['created_at', 'created_by_id', 'id', 'title']);
    expect(r.relations.map((x) => `${x.from}>${x.to}`)).toEqual(['blog_article>auth_user', 'blog_comment>auth_user']);
    const ext = r.entities[2];
    expect(ext).toMatchObject({ external: true, name: 'auth_user' });
    expect(ext.columns).toEqual([expect.objectContaining({ name: 'id', primaryKey: true })]);
  });

  it('stores single-table-inheritance children in their base table', () => {
    const mig = 'db/migrate/1_init.rb';
    const r = resolveSchema([
      result(mig, 'rails', {
        origin: 'migration',
        entities: [table(mig, 'users', [pk(), col('type', 'string'), col('team_id', 'bigint')]), table(mig, 'teams', [pk()])],
      }),
      result('app/models/user.rb', 'rails', { entities: [table('app/models/user.rb', 'users', [], { modelName: 'User', nameCertainty: 0 })] }),
      result('app/models/team.rb', 'rails', { entities: [table('app/models/team.rb', 'teams', [], { modelName: 'Team', nameCertainty: 0 })] }),
      result('app/models/admin.rb', 'rails', {
        entities: [table('app/models/admin.rb', 'admins', [], { modelName: 'Admin', nameCertainty: 0, sharedTable: true, extends: ['User'] })],
        relations: [rel('app/models/admin.rb', { model: 'Admin' }, ['team_id'], { model: 'Team' }, [], { kind: 'orm' })],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['teams', 'users']);
    expect(r.entities[1].modelNames).toEqual(['User', 'Admin']);
    expect(r.entities[1].source?.file).toBe('app/models/user.rb');
    expect(r.relations).toEqual([expect.objectContaining({ from: 'users', fromColumns: ['team_id'], to: 'teams' })]);
  });

  it('lets models with guessed table names adopt explicitly named tables', () => {
    const mig = 'Migrations/20240101_Init.cs';
    const r = resolveSchema([
      result(mig, 'efcore', {
        origin: 'migration',
        entities: [table(mig, 'Posts', [pk('Id'), col('Title', 'nvarchar(max)', { nullable: false }), col('BlogId', 'int'), col('Legacy', 'int')])],
      }),
      result('Models/Post.cs', 'efcore', {
        entities: [
          table('Models/Post.cs', 'Post', [pk('Id', 'int'), col('Title', 'string'), col('BlogId', 'int'), col('Summary', 'string')], { modelName: 'Post', nameCertainty: 0 }, 3),
        ],
        relations: [rel('Models/Post.cs', { name: 'Post' }, ['BlogId'], { name: 'Blogs' }, [], { kind: 'orm' })],
      }),
      result('src/user.entity.ts', 'typeorm', {
        entities: [table('src/user.entity.ts', 'user', [pk('id')], { modelName: 'User', nameCertainty: 0 })],
      }),
      result('db/schema.sql', 'sql', { entities: [table('db/schema.sql', 'users', [pk('id', 'serial'), col('email')])] }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['posts', 'users', 'blogs']);
    const posts = r.entities[0];
    expect(posts.modelNames).toEqual(['Post']);
    expect(names(posts.columns)).toEqual(['Id', 'Title', 'BlogId', 'Summary']);
    expect(posts.source).toEqual({ file: 'Models/Post.cs', line: 3 });
    expect(r.relations).toEqual([expect.objectContaining({ from: 'posts', fromColumns: ['BlogId'], to: 'blogs' })]);
    const users = r.entities[1];
    expect(users.modelNames).toEqual(['User']);
    expect(names(users.columns)).toEqual(['id', 'email']); // explicit schema.sql table is complete
    expect(users.sources.sort()).toEqual(['sql', 'typeorm']);
  });

  it('merges a link to a guessed placeholder into the real link on the same FK columns', () => {
    const r = resolveSchema([
      result('Domain/FollowedPeople.cs', 'efcore', {
        entities: [
          table('Domain/FollowedPeople.cs', 'FollowedPeople', [col('ObserverId', 'int', { primaryKey: true, nullable: false }), col('TargetId', 'int', { primaryKey: true, nullable: false })], { modelName: 'FollowedPeople', nameCertainty: 0 }),
          table('Domain/Person.cs', 'Persons', [pk('PersonId')], { modelName: 'Person' }),
        ],
        relations: [rel('Domain/FollowedPeople.cs', { model: 'FollowedPeople' }, ['ObserverId'], { model: 'Person' }, [], { kind: 'orm' }, 3)],
      }),
      result('Data/Context.cs', 'efcore', {
        // fluent HasOne(x => x.Observer): the parser only knows the navigation name
        relations: [rel('Data/Context.cs', { model: 'FollowedPeople' }, ['ObserverId'], { model: 'Observer' }, [], { kind: 'orm', onDelete: 'RESTRICT' }, 20)],
      }),
    ]);
    expect(r.entities.map((e) => e.id)).toEqual(['followedpeople', 'persons']);
    expect(r.relations).toEqual([expect.objectContaining({ from: 'followedpeople', fromColumns: ['ObserverId'], to: 'persons', onDelete: 'RESTRICT' })]);
  });

  it('drops associations whose FK column does not exist, unless the ORM creates FK columns itself', () => {
    const schema = 'db/schema.rb';
    const r = resolveSchema([
      result(schema, 'rails', {
        entities: [table(schema, 'articles', [pk(), col('user_id', 'integer')]), table(schema, 'users', [pk()])],
      }),
      result('app/models/article.rb', 'rails', {
        entities: [table('app/models/article.rb', 'articles', [], { modelName: 'Article', nameCertainty: 0 })],
        relations: [
          rel('app/models/article.rb', { model: 'Article' }, ['user_id'], { model: 'User' }, [], { kind: 'orm' }, 1),
          // has_many :articles inside Article → FK article_id on articles, which does not exist
          rel('app/models/article.rb', { model: 'Article' }, ['id'], { model: 'Article' }, ['article_id'], { kind: 'orm', cardinality: 'one-to-many' }, 14),
        ],
      }),
      result('src/post.entity.ts', 'typeorm', {
        entities: [
          table('src/post.entity.ts', 'post', [pk(), col('title', 'varchar')], { modelName: 'Post', nameCertainty: 0 }),
          table('src/post.entity.ts', 'author', [pk()], { modelName: 'Author', nameCertainty: 0 }),
        ],
        relations: [rel('src/post.entity.ts', { model: 'Post' }, ['authorId'], { model: 'Author' }, [], { kind: 'orm' })],
      }),
    ]);
    expect(r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}`)).toEqual(['articles.user_id>users', 'post.authorId>author']);
    expect(r.warnings).toEqual([expect.objectContaining({ file: 'app/models/article.rb', line: 14, message: expect.stringContaining('article_id') })]);
    expect(names(r.entities.find((e) => e.id === 'post')!.columns)).toEqual(['id', 'title', 'authorId']);
  });

  it('guesses missing FK columns and synthesizes implied ones for models without a column list', () => {
    const r = resolveSchema([
      result('models/post.js', 'sequelize', {
        entities: [
          table('models/post.js', 'Posts', [pk(), col('UserId', 'INTEGER')], { modelName: 'Post' }),
          table('models/user.js', 'Users', [pk()], { modelName: 'User' }),
        ],
        relations: [rel('models/post.js', { model: 'Post' }, [], { model: 'User' }, [], { kind: 'orm' })],
      }),
      result('app/models/comment.rb', 'rails', {
        entities: [table('app/models/comment.rb', 'comments', [], { modelName: 'Comment' })],
        relations: [rel('app/models/comment.rb', { model: 'Comment' }, ['author_id'], { model: 'Author', name: 'authors' }, [], { kind: 'orm' })],
      }),
    ]);
    expect(r.relations.find((x) => x.from === 'posts')).toMatchObject({ fromColumns: ['UserId'], to: 'users', toColumns: ['id'] });
    const comments = r.entities.find((e) => e.id === 'comments')!;
    expect(names(comments.columns)).toEqual(['author_id']);
    expect(r.entities.find((e) => e.id === 'authors')).toMatchObject({ external: true });
  });

  it('ignores relations from unknown entities with a warning, and dangling references to dropped tables', () => {
    const m = 'm/001.sql';
    const r = resolveSchema(
      [
        result(m, 'sql', {
          origin: 'migration',
          entities: [table(m, 'accounts', [pk()]), table(m, 'orders', [pk(), col('account_id', 'int')])],
          relations: [rel(m, 'orders', ['account_id'], 'accounts')],
          ops: [{ op: 'dropTable', table: { name: 'accounts' }, source: src(m, 9) }],
        }),
        result('x.rb', 'rails', { relations: [rel('x.rb', { model: 'Ghost' }, ['user_id'], { model: 'User' }, [], { kind: 'orm' })] }),
      ],
      { inferRelations: false },
    );
    expect(r.entities.map((e) => e.id)).toEqual(['orders']);
    expect(r.relations).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ file: 'x.rb', message: expect.stringContaining('Ghost') })]);
  });
});

describe('cardinality, inference and join tables', () => {
  it('detects one-to-one relations from unique or primary-key foreign keys', () => {
    const f = 's.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [
          table(f, 'users', [pk()]),
          table(f, 'profiles', [pk('user_id')]),
          table(f, 'wallets', [pk(), col('owner_id', 'int', { unique: true, nullable: false })]),
        ],
        relations: [rel(f, 'profiles', ['user_id'], 'users'), rel(f, 'wallets', ['owner_id'], 'users')],
      }),
    ]);
    expect(r.relations.map((x) => [x.from, x.cardinality, x.optional])).toEqual([
      ['profiles', 'one-to-one', false],
      ['wallets', 'one-to-one', false],
    ]);
  });

  it('infers relations from naming conventions (and can be disabled)', () => {
    const f = 's.sql';
    const input = [
      result(f, 'sql', {
        entities: [
          table(f, 'users', [pk()]),
          table(f, 'orders', [pk(), col('user_id', 'int'), col('external_id', 'text')]),
          table(f, 'comments', [pk(), col('commentable_id', 'int'), col('commentable_type', 'text')]),
          table(f, 'commentables', [pk()]),
        ],
      }),
      result('m.js', 'mongoose', {
        entities: [
          { name: 'users', kind: 'collection', modelName: 'User', columns: [pk('_id', 'ObjectId')], source: src('m.js') },
          { name: 'carts', kind: 'collection', modelName: 'Cart', columns: [pk('_id', 'ObjectId'), col('userId', 'ObjectId')], source: src('m.js') },
        ],
      }),
    ];
    const r = resolveSchema(input);
    expect(r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}.${x.toColumns}:${x.kind}`)).toEqual([
      'doc:carts.userId>doc:users._id:inferred',
      'orders.user_id>users.id:inferred',
    ]);
    const orders = r.entities.find((e) => e.id === 'orders')!;
    expect(orders.columns[1].references).toEqual({ entity: 'users', column: 'id', inferred: true });
    expect(resolveSchema(input, { inferRelations: false }).relations).toEqual([]);
  });

  it('marks pure junction tables and adds a many-to-many relation for them', () => {
    const f = 's.sql';
    const r = resolveSchema([
      result(f, 'sql', {
        entities: [
          table(f, 'posts', [pk()]),
          table(f, 'tags', [pk()]),
          table(f, 'post_tags', [col('post_id', 'int', { primaryKey: true, nullable: false }), col('tag_id', 'int', { primaryKey: true, nullable: false }), col('created_at', 'timestamp')]),
          table(f, 'order_items', [pk(), col('post_id', 'int'), col('tag_id', 'int'), col('quantity', 'int')]),
        ],
        relations: [
          rel(f, 'post_tags', ['post_id'], 'posts'),
          rel(f, 'post_tags', ['tag_id'], 'tags'),
          rel(f, 'order_items', ['post_id'], 'posts'),
          rel(f, 'order_items', ['tag_id'], 'tags'),
        ],
      }),
    ]);
    expect(r.entities.filter((e) => e.joinTable).map((e) => e.id)).toEqual(['post_tags']);
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    expect(m2m).toEqual([expect.objectContaining({ from: 'posts', to: 'tags', through: 'post_tags', throughName: 'post_tags', kind: 'foreign-key' })]);
  });

  it('links declared many-to-many relations to their join table and de-duplicates both sides', () => {
    const p = 'prisma/schema.prisma';
    const m = 'prisma/migrations/1/migration.sql';
    const r = resolveSchema([
      result(p, 'prisma', {
        entities: [table(p, 'Post', [pk()], { modelName: 'Post' }), table(p, 'Category', [pk()], { modelName: 'Category' })],
        relations: [
          rel(p, { model: 'Post' }, [], { model: 'Category' }, [], { cardinality: 'many-to-many', kind: 'orm', through: { name: '_CategoryToPost' } }),
          rel(p, { model: 'Category' }, [], { model: 'Post' }, [], { cardinality: 'many-to-many', kind: 'orm', through: { name: '_CategoryToPost' } }),
        ],
      }),
      result(m, 'sql', {
        origin: 'migration',
        entities: [table(m, '_CategoryToPost', [col('A', 'INTEGER', { nullable: false }), col('B', 'INTEGER', { nullable: false })])],
        relations: [rel(m, '_CategoryToPost', ['A'], 'Category', ['id']), rel(m, '_CategoryToPost', ['B'], 'Post', ['id'])],
      }),
    ]);
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    expect(m2m).toHaveLength(1);
    expect(m2m[0]).toMatchObject({ through: '_categorytopost', throughName: '_CategoryToPost', kind: 'orm' });
    expect(r.entities.find((e) => e.id === '_categorytopost')!.joinTable).toBe(true);
  });
});

describe('enums', () => {
  it('links column types to enums and replays enum migrations', () => {
    const p = 'schema.prisma';
    const f1 = 'migrations/001.sql';
    const f2 = 'migrations/002.sql';
    const r = resolveSchema([
      result(p, 'prisma', {
        entities: [table(p, 'User', [pk(), col('role', 'Role')], { modelName: 'User' })],
        enums: [{ name: 'Role', values: ['USER', 'ADMIN'], source: src(p, 9) }],
      }),
      result(f1, 'sql', {
        origin: 'migration',
        entities: [table(f1, 'people', [pk(), col('moods', '"mood"[]', { isArray: true })], {}, 3)],
        enums: [
          { name: 'mood', values: ['sad', 'ok'], source: src(f1, 0) },
          { name: 'mood', values: ['happy'], partial: true, source: src(f1, 1) },
        ],
      }),
      result(f2, 'sql', {
        origin: 'migration',
        enums: [{ name: 'mood', values: ['ok', 'great'], source: src(f2, 1) }],
        ops: [
          { op: 'renameEnum', name: 'mood', to: 'mood_old', source: src(f2, 0) },
          { op: 'dropEnum', name: 'mood_old', source: src(f2, 2) },
        ],
      }),
    ]);
    expect(r.enums.map((e) => [e.id, e.values])).toEqual([
      ['mood', ['ok', 'great']],
      ['role', ['USER', 'ADMIN']],
    ]);
    expect(r.entities.find((e) => e.id === 'user')!.columns[1].enumRef).toBe('role');
    expect(r.entities.find((e) => e.id === 'people')!.columns[1].enumRef).toBe('mood');
  });

  it('resolves enum hints set by parsers and drops dangling ones', () => {
    const f = 'models/user.js';
    const r = resolveSchema([
      result(f, 'sequelize', {
        entities: [
          table(f, 'Users', [pk(), col('status', 'ENUM', { enumRef: 'Users_status' }), col('kind', 'ENUM', { enumRef: 'nope' })], { modelName: 'User' }),
        ],
        enums: [{ name: 'Users_status', values: ['active', 'banned'], source: src(f, 3) }],
      }),
      result('b.sql', 'sql', { entities: [table('b.sql', 'logs', [pk(), col('level', 'text', { enumRef: 'missing' })])] }),
    ]);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.columns[1].enumRef).toBe('users_status');
    expect(users.columns[2].enumRef).toBeUndefined();
    expect(r.entities.find((e) => e.id === 'logs')!.columns[1].enumRef).toBeUndefined();
  });
});

describe('buildModel', () => {
  it('aggregates engines, assigns them to entities and summarizes sources', () => {
    const model = buildModel({
      workspaceName: 'demo',
      now: new Date('2026-01-02T03:04:05Z'),
      stats: { filesFound: 3, filesRead: 3, filesParsed: 2, durationMs: 12, truncated: false },
      results: [
        result('prisma/schema.prisma', 'prisma', {
          entities: [table('prisma/schema.prisma', 'User', [pk()], { modelName: 'User' }), table('prisma/schema.prisma', 'Post', [pk()], { modelName: 'Post' })],
          engines: [{ engine: 'postgresql', line: 2, detail: 'datasource provider "postgresql"' }],
          warnings: [{ line: 4, message: 'odd attribute' }],
        }),
        result('models/cart.js', 'mongoose', {
          entities: [{ name: 'carts', kind: 'collection', modelName: 'Cart', columns: [pk('_id', 'ObjectId')], source: src('models/cart.js', 3), engine: 'mongodb' }],
        }),
      ],
      engineHints: [
        { file: 'docker-compose.yml', hint: { engine: 'postgresql', line: 5, detail: 'image "postgres:16"' } },
        { file: 'docker-compose.yml', hint: { engine: 'redis', line: 9, detail: 'image "redis:7"' } },
      ],
    });
    expect(model.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(model.engines.map((e) => [e.id, e.evidence.length])).toEqual([
      ['postgresql', 2],
      ['mongodb', 1],
      ['redis', 1],
    ]);
    expect(model.engines[1].evidence[0]).toEqual({ file: 'models/cart.js', line: 3, detail: 'Mongoose model "carts"' });
    expect(model.entities.map((e) => [e.id, e.engine])).toEqual([
      ['doc:carts', 'mongodb'],
      ['post', 'postgresql'],
      ['user', 'postgresql'],
    ]);
    expect(model.sources).toEqual([
      { kind: 'prisma', label: 'Prisma', files: 1, entities: 2 },
      { kind: 'mongoose', label: 'Mongoose', files: 1, entities: 1 },
    ]);
    expect(model.warnings).toEqual([{ file: 'prisma/schema.prisma', line: 4, message: 'odd attribute' }]);
  });
});
