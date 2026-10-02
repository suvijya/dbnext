import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { ectoParser } from '../../../src/parsers/ecto';

const parse = (path: string, text: string) => ectoParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'ecto', result: parse(path, text) });
const colNames = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('ecto detect', () => {
  it('claims schema and migration files', () => {
    expect(ectoParser.detect({ path: 'lib/app/user.ex', text: 'use Ecto.Schema' })).toBe(true);
    expect(ectoParser.detect({ path: 'priv/repo/migrations/x.exs', text: 'use Ecto.Migration' })).toBe(true);
  });

  it('ignores unrelated Elixir', () => {
    expect(ectoParser.detect({ path: 'lib/app/server.ex', text: 'defmodule Foo do\n  use GenServer\nend' })).toBe(false);
  });
});

describe('ecto schema', () => {
  const text = `
defmodule MyApp.Accounts.User do
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  @schema_prefix "auth"

  # a field named like a macro must not confuse the scanner
  schema "users" do
    field :email, :string, null: false
    field :name, :string
    field :role, Ecto.Enum, values: [:member, :admin]
    field :tags, {:array, :string}
    field :field, :string

    belongs_to :org, MyApp.Accounts.Org
    has_many :posts, MyApp.Blog.Post
    has_one :profile, MyApp.Accounts.Profile

    timestamps()
  end
end
`;

  const result = parse('lib/app/user.ex', text);
  const user = result.entities[0];

  it('reads the table name, prefix, model and binary_id primary key', () => {
    expect(user).toMatchObject({ name: 'users', schema: 'auth', modelName: 'User', nameCertainty: 2 });
    expect(user.columns[0]).toMatchObject({ name: 'id', type: 'binary_id', primaryKey: true, nullable: false });
  });

  it('reads fields, enums, arrays and the belongs_to foreign key column', () => {
    expect(colNames(user.columns)).toEqual([
      'id',
      'email',
      'name',
      'role',
      'tags',
      'field',
      'org_id',
      'inserted_at',
      'updated_at',
    ]);
    expect(user.columns.find((c) => c.name === 'email')!.nullable).toBe(false);
    expect(user.columns.find((c) => c.name === 'tags')).toMatchObject({ type: 'string', isArray: true });
    expect(user.columns.find((c) => c.name === 'org_id')!.type).toBe('binary_id');
    const role = user.columns.find((c) => c.name === 'role')!;
    expect(role.enumRef).toBe('users_role');
    expect(result.enums).toEqual([expect.objectContaining({ name: 'users_role', values: ['member', 'admin'] })]);
  });

  it('emits the associations with the right direction', () => {
    const bt = result.relations.find((r) => r.fromColumns[0] === 'org_id')!;
    expect(bt).toMatchObject({ cardinality: 'many-to-one', kind: 'orm' });
    expect(bt.to).toEqual({ model: 'Org' });
    const hm = result.relations.find((r) => r.cardinality === 'one-to-many')!;
    expect(hm.to).toEqual({ model: 'Post' });
    expect(hm.toColumns).toEqual(['user_id']);
    const ho = result.relations.find((r) => r.cardinality === 'one-to-one')!;
    expect(ho.from).toEqual({ model: 'Profile' });
    expect(ho.fromColumns).toEqual(['user_id']);
  });
});

describe('ecto migration', () => {
  const text = `
defmodule MyApp.Repo.Migrations.CreateBlog do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :email, :string, null: false
      timestamps()
    end

    create table(:posts) do
      add :title, :string
      add :user_id, references(:users, on_delete: :delete_all, type: :binary_id)
      add :views, :integer, default: 0
      timestamps()
    end

    create index(:posts, [:user_id])
    create unique_index(:users, [:email])

    alter table(:posts) do
      add :slug, :string
      modify :title, :text, null: false
      remove :views
    end

    rename table(:posts), :slug, to: :permalink
    drop table(:legacy)
  end

  def down do
    drop table(:users)
    drop table(:posts)
  end
end
`;

  const result = parse('priv/repo/migrations/20240101_create_blog.exs', text);

  it('is tagged as migration history', () => {
    expect(result.origin).toBe('migration');
  });

  it('creates tables honouring primary_key: false and references', () => {
    const posts = result.entities.find((e) => e.name === 'posts' && !e.partial)!;
    expect(colNames(posts.columns)).toEqual(['id', 'title', 'user_id', 'views', 'inserted_at', 'updated_at']);
    const users = result.entities.find((e) => e.name === 'users' && !e.partial)!;
    expect(colNames(users.columns)).toEqual(['id', 'email', 'inserted_at', 'updated_at']);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'binary_id', primaryKey: true });
  });

  it('reads the foreign key from references()', () => {
    const rel = result.relations.find((r) => r.fromColumns[0] === 'user_id')!;
    expect(rel).toMatchObject({ cardinality: 'many-to-one', kind: 'foreign-key', onDelete: 'CASCADE' });
    expect(rel.to).toEqual({ name: 'users' });
  });

  it('records alter / rename / drop as ops and ignores the down direction', () => {
    const kinds = result.ops!.map((o) => o.op);
    expect(kinds).toContain('alterColumn');
    expect(kinds).toContain('dropColumn');
    expect(kinds).toContain('renameColumn');
    const drops = result.ops!.filter((o) => o.op === 'dropTable').map((o) => (o as { table: { name: string } }).table.name);
    expect(drops).toEqual(['legacy']); // users / posts drops live in def down
    const alter = result.ops!.find((o) => o.op === 'alterColumn') as { set: { type?: string; nullable?: boolean } };
    expect(alter.set).toMatchObject({ type: 'text', nullable: false });
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.exs', 'use Ecto.Migration\ndef change do\n  create table(:x\n    add :y,\nend')).not.toThrow();
  });
});

describe('ecto end-to-end', () => {
  const user = `
defmodule MyApp.Accounts.User do
  use Ecto.Schema
  schema "users" do
    field :name, :string
    belongs_to :org, MyApp.Accounts.Org
    has_many :posts, MyApp.Blog.Post
  end
end
`;
  const org = `
defmodule MyApp.Accounts.Org do
  use Ecto.Schema
  schema "orgs" do
    field :name, :string
    has_many :users, MyApp.Accounts.User
  end
end
`;
  const post = `
defmodule MyApp.Blog.Post do
  use Ecto.Schema
  schema "posts" do
    field :title, :string
    belongs_to :user, MyApp.Accounts.User
    many_to_many :tags, MyApp.Blog.Tag, join_through: "posts_tags"
  end
end
`;
  const tag = `
defmodule MyApp.Blog.Tag do
  use Ecto.Schema
  schema "tags" do
    field :label, :string
  end
end
`;

  const r = resolveSchema([
    fr('lib/accounts/user.ex', user),
    fr('lib/accounts/org.ex', org),
    fr('lib/blog/post.ex', post),
    fr('lib/blog/tag.ex', tag),
  ]);

  it('builds the expected entities', () => {
    expect(r.entities.map((e) => e.id)).toEqual(['orgs', 'posts', 'tags', 'users']);
  });

  it('links posts → users and users → orgs with the right columns and cardinality', () => {
    const toUsers = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(toUsers).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['user_id'] });
    const toOrgs = r.relations.find((x) => x.from === 'users' && x.to === 'orgs')!;
    expect(toOrgs).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['org_id'] });
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'user_id')!.references).toMatchObject({ entity: 'users' });
  });

  it('builds the many-to-many through the join table name', () => {
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect([m2m.from, m2m.to].sort()).toEqual(['posts', 'tags']);
    expect(m2m.throughName).toBe('posts_tags');
  });
});
