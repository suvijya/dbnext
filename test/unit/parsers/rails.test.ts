import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { railsParser } from '../../../src/parsers/rails';

const parse = (path: string, text: string) => railsParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'rails', result: parse(path, text) });
const colNames = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('rails detect', () => {
  it('claims schema.rb, migrations and models', () => {
    expect(railsParser.detect({ path: 'db/schema.rb', text: 'ActiveRecord::Schema[7.1].define do\nend' })).toBe(true);
    expect(railsParser.detect({ path: 'db/migrate/1_x.rb', text: 'class X < ActiveRecord::Migration[7.1]\nend' })).toBe(true);
    expect(railsParser.detect({ path: 'app/models/user.rb', text: 'class User < ApplicationRecord\n  has_many :posts\nend' })).toBe(true);
  });

  it('ignores unrelated Ruby', () => {
    expect(railsParser.detect({ path: 'lib/util.rb', text: 'class Util\n  def run; end\nend' })).toBe(false);
  });
});

describe('rails schema.rb', () => {
  const text = `ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  enable_extension "pgcrypto"

  create_enum "order_status", ["pending", "shipped", "delivered"]

  create_table "users", id: :uuid, force: :cascade, comment: "People" do |t|
    t.string "email", default: "", null: false, limit: 255, comment: "Login"
    t.string "name"
    t.boolean "active", default: true, null: false
    t.references "account", null: false
    t.index ["email"], name: "idx_users_email", unique: true
    t.timestamps
  end

  create_table "posts", force: :cascade do |t|
    t.string "title", null: false
    t.bigint "author_id", null: false
    t.enum "status", enum_type: "order_status"
    t.timestamps
  end

  create_table "flags", id: false, force: :cascade do |t|
    t.string "key", null: false
  end

  add_foreign_key "posts", "users", column: "author_id", on_delete: :cascade
  add_index "posts", ["author_id"], name: "idx_posts_author"
end
`;
  const result = parse('db/schema.rb', text);
  const users = result.entities.find((e) => e.name === 'users')!;
  const posts = result.entities.find((e) => e.name === 'posts' && !e.partial)!;
  const flags = result.entities.find((e) => e.name === 'flags')!;

  it('reads tables, the uuid primary key, columns and comments', () => {
    expect(users).toMatchObject({ nameCertainty: 2, comment: 'People' });
    expect(colNames(users.columns)).toEqual(['id', 'email', 'name', 'active', 'account_id', 'created_at', 'updated_at']);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'uuid', primaryKey: true, generated: true });
    expect(users.columns.find((c) => c.name === 'email')).toMatchObject({ nullable: false, default: '', comment: 'Login' });
    expect(users.columns.find((c) => c.name === 'created_at')!.nullable).toBe(false);
    expect(users.indexes).toEqual([expect.objectContaining({ columns: ['email'], name: 'idx_users_email', unique: true })]);
  });

  it('honours id: false and resolves PG enum columns', () => {
    expect(colNames(flags.columns)).toEqual(['key']); // no implicit id
    expect(posts.columns.find((c) => c.name === 'status')!.enumRef).toBe('order_status');
    expect(result.enums).toEqual([expect.objectContaining({ name: 'order_status', values: ['pending', 'shipped', 'delivered'] })]);
  });

  it('reads add_foreign_key and emits a postgresql engine hint', () => {
    const rel = result.relations.find((r) => r.fromColumns[0] === 'author_id')!;
    expect(rel).toMatchObject({ from: { name: 'posts' }, to: { name: 'users' }, onDelete: 'CASCADE', cardinality: 'many-to-one' });
    expect(result.engines).toEqual([expect.objectContaining({ engine: 'postgresql' })]);
  });
});

describe('rails migration', () => {
  const text = `class CreateBlog < ActiveRecord::Migration[7.1]
  def change
    create_table :users, id: :uuid do |t|
      t.string :email, null: false
      t.timestamps
    end

    create_table :posts do |t|
      t.string :title
      t.references :author, null: false, foreign_key: { to_table: :users }, type: :uuid
      t.references :commentable, polymorphic: true, null: false
      t.timestamps
    end

    create_join_table :users, :roles

    add_column :users, :nickname, :string
    add_reference :posts, :category, foreign_key: true
    change_column_null :users, :email, true
    rename_column :posts, :title, :headline
    remove_column :posts, :draft
    add_foreign_key :comments, :posts, column: :post_id, on_delete: :nullify
    drop_table :legacy

    change_table :users do |t|
      t.integer :age
      t.remove :nickname
    end
  end

  def down
    drop_table :users
    drop_table :posts
  end
end
`;
  const result = parse('db/migrate/20240101_create_blog.rb', text);

  it('is tagged as migration history', () => {
    expect(result.origin).toBe('migration');
  });

  it('creates tables, references (FK + polymorphic) and the join table', () => {
    const posts = result.entities.find((e) => e.name === 'posts' && !e.partial)!;
    expect(colNames(posts.columns)).toEqual(['id', 'title', 'author_id', 'commentable_id', 'commentable_type', 'created_at', 'updated_at']);
    const toUsers = result.relations.find((r) => r.fromColumns[0] === 'author_id')!;
    expect(toUsers.to).toEqual({ name: 'users' });
    expect(result.relations.some((r) => r.fromColumns[0] === 'commentable_id')).toBe(false);
    const join = result.entities.find((e) => e.name === 'roles_users')!;
    expect(colNames(join.columns)).toEqual(['user_id', 'role_id']);
    const toCat = result.relations.find((r) => r.fromColumns[0] === 'category_id')!;
    expect(toCat.to).toEqual({ name: 'categories' });
  });

  it('records column ops and ignores the down direction', () => {
    const kinds = result.ops!.map((o) => o.op);
    expect(kinds).toContain('renameColumn');
    expect(kinds).toContain('alterColumn');
    expect(kinds).toContain('dropColumn');
    const drops = result.ops!.filter((o) => o.op === 'dropTable').map((o) => (o as { table: { name: string } }).table.name);
    expect(drops).toEqual(['legacy']);
    const fk = result.relations.find((r) => r.fromColumns[0] === 'post_id')!;
    expect(fk).toMatchObject({ from: { name: 'comments' }, to: { name: 'posts' }, onDelete: 'SET NULL' });
    // change_table add + remove
    const added = result.entities.filter((e) => e.partial).flatMap((e) => colNames(e.columns));
    expect(added).toContain('age');
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.rb', 'class M < ActiveRecord::Migration[7.1]\n def change\n  create_table :x do |t|\n   t.string\n')).not.toThrow();
  });
});

describe('rails models', () => {
  const text = `class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end

module Blog
  class Post < ApplicationRecord
    self.table_name = "blog_posts"
    belongs_to :author, class_name: "User", foreign_key: :author_id
    has_many :comments, dependent: :destroy
    has_and_belongs_to_many :tags
    enum status: { draft: 0, published: 1 }
  end
end

class User < ApplicationRecord
  has_many :posts, foreign_key: :author_id, class_name: "Post"
  has_one :profile
end

class Admin < User
  belongs_to :team, optional: true
end
`;
  const result = parse('app/models/all.rb', text);
  const post = result.entities.find((e) => e.modelName === 'Post')!;
  const admin = result.entities.find((e) => e.modelName === 'Admin')!;

  it('maps model classes to tables and marks abstract / STI classes', () => {
    expect(result.entities.find((e) => e.modelName === 'ApplicationRecord')!.abstract).toBe(true);
    expect(post).toMatchObject({ name: 'blog_posts', nameCertainty: 2 });
    expect(admin).toMatchObject({ sharedTable: true, extends: ['User'] });
    expect(result.entities.find((e) => e.modelName === 'User')).toMatchObject({ name: 'users', nameCertainty: 0 });
  });

  it('reads associations with correct direction and default foreign keys', () => {
    const bt = result.relations.find((r) => r.fromColumns[0] === 'author_id' && r.cardinality === 'many-to-one')!;
    expect(bt.to).toEqual({ model: 'User' });
    const hm = result.relations.find((r) => r.cardinality === 'one-to-many' && r.toColumns[0] === 'post_id')!;
    expect(hm.to).toEqual({ model: 'Comment' });
    const ho = result.relations.find((r) => r.cardinality === 'one-to-one')!;
    expect(ho).toMatchObject({ from: { model: 'Profile' }, fromColumns: ['user_id'] });
    const habtm = result.relations.find((r) => r.cardinality === 'many-to-many')!;
    expect(habtm.through).toEqual({ name: 'blog_posts_tags' });
    expect(result.enums).toEqual([expect.objectContaining({ name: 'blog_posts_status', values: ['draft', 'published'] })]);
  });
});

describe('rails end-to-end', () => {
  const schema = `ActiveRecord::Schema[7.1].define(version: 1) do
  create_table "users", force: :cascade do |t|
    t.string "email", null: false
  end
  create_table "posts", force: :cascade do |t|
    t.string "title"
    t.bigint "author_id", null: false
  end
  add_foreign_key "posts", "users", column: "author_id"
end
`;
  const userModel = `class User < ApplicationRecord\n  has_many :posts, foreign_key: :author_id, class_name: "Post"\nend`;
  const postModel = `class Post < ApplicationRecord\n  belongs_to :author, class_name: "User", foreign_key: :author_id\nend`;

  const r = resolveSchema([
    fr('db/schema.rb', schema),
    fr('app/models/user.rb', userModel),
    fr('app/models/post.rb', postModel),
  ]);

  it('merges schema columns with model names and links posts → users', () => {
    expect(r.entities.map((e) => e.id)).toEqual(['posts', 'users']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.modelNames).toContain('Post');
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toMatchObject({ entity: 'users' });
    const rel = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(rel).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['author_id'], optional: false });
  });
});
