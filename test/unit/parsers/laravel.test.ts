import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { laravelParser } from '../../../src/parsers/laravel';

const parse = (path: string, text: string) => laravelParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'laravel', result: parse(path, text) });
const colNames = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('laravel detect', () => {
  it('claims migrations and Eloquent models', () => {
    expect(
      laravelParser.detect({
        path: 'database/migrations/x.php',
        text: 'use Illuminate\\Database\\Schema\\Blueprint;\nSchema::create("users", function (Blueprint $t) {});',
      }),
    ).toBe(true);
    expect(laravelParser.detect({ path: 'app/Models/User.php', text: 'class User extends Authenticatable {}' })).toBe(true);
    expect(laravelParser.detect({ path: 'app/Models/Post.php', text: 'class Post extends Model {}' })).toBe(true);
  });

  it('does not claim Doctrine entities', () => {
    const doctrine = `use Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass Product {}`;
    expect(laravelParser.detect({ path: 'src/Entity/Product.php', text: doctrine })).toBe(false);
  });

  it('ignores unrelated PHP', () => {
    expect(laravelParser.detect({ path: 'src/Helper.php', text: '<?php class Helper { function run() {} }' })).toBe(false);
  });
});

describe('laravel migration', () => {
  const text = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('name', 100);
            $table->string('email')->unique()->nullable();
            $table->string('password');
            $table->enum('status', ['active', 'banned'])->default('active');
            $table->rememberToken();
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('editor_id')->nullable()->constrained('users');
            $table->morphs('commentable');
            $table->timestamps();
        });

        Schema::table('users', function (Blueprint $table) {
            $table->string('phone')->nullable();
            $table->string('name', 150)->change();
            $table->dropColumn('password');
        });

        Schema::dropIfExists('legacy');
    }

    public function down(): void
    {
        Schema::dropIfExists('users');
        Schema::dropIfExists('posts');
    }
};
`;
  const result = parse('database/migrations/2024_01_01_000000_init.php', text);
  const users = result.entities.find((e) => e.name === 'users' && !e.partial)!;
  const posts = result.entities.find((e) => e.name === 'posts')!;

  it('is tagged as migration history', () => {
    expect(result.origin).toBe('migration');
  });

  it('reads columns, the auto-increment id, enum, token, timestamps and soft deletes', () => {
    expect(colNames(users.columns)).toEqual([
      'id',
      'name',
      'email',
      'password',
      'status',
      'remember_token',
      'created_at',
      'updated_at',
      'deleted_at',
    ]);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'bigint', primaryKey: true, generated: true });
    expect(users.columns.find((c) => c.name === 'email')).toMatchObject({ unique: true, nullable: true });
    expect(users.columns.find((c) => c.name === 'name')!.nullable).toBe(false);
    const status = users.columns.find((c) => c.name === 'status')!;
    expect(status.enumRef).toBe('users_status');
    expect(status.default).toBe('active');
    expect(result.enums).toEqual([expect.objectContaining({ name: 'users_status', values: ['active', 'banned'] })]);
  });

  it('creates foreign keys from constrained() and polymorphic morphs columns', () => {
    expect(colNames(posts.columns)).toEqual([
      'id',
      'title',
      'user_id',
      'editor_id',
      'commentable_id',
      'commentable_type',
      'created_at',
      'updated_at',
    ]);
    const toUsers = result.relations.find((r) => r.fromColumns[0] === 'user_id')!;
    expect(toUsers).toMatchObject({ to: { name: 'users' }, cardinality: 'many-to-one', onDelete: 'cascade', optional: false });
    const editor = result.relations.find((r) => r.fromColumns[0] === 'editor_id')!;
    expect(editor).toMatchObject({ to: { name: 'users' }, optional: true });
    // morphs produce no relation
    expect(result.relations.some((r) => r.fromColumns[0] === 'commentable_id')).toBe(false);
  });

  it('records Schema::table adds, change() and drops as partials and ops', () => {
    const partial = result.entities.find((e) => e.name === 'users' && e.partial)!;
    expect(colNames(partial.columns)).toEqual(['phone']);
    const kinds = result.ops!.map((o) => o.op);
    expect(kinds).toContain('alterColumn');
    expect(kinds).toContain('dropColumn');
    const drops = result.ops!.filter((o) => o.op === 'dropTable').map((o) => (o as { table: { name: string } }).table.name);
    expect(drops).toEqual(['legacy']); // down() drops are ignored
    const alter = result.ops!.find((o) => o.op === 'alterColumn') as { column: string; set: { nullable?: boolean } };
    expect(alter.column).toBe('name');
    expect(alter.set.nullable).toBe(false);
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.php', '<?php Schema::create("x", function (Blueprint $t) { $t->string( })')).not.toThrow();
  });
});

describe('laravel eloquent models', () => {
  const text = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;

class Post extends Model
{
    protected $table = 'blog_posts';

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }

    public function comments()
    {
        return $this->hasMany(Comment::class);
    }

    public function tags()
    {
        return $this->belongsToMany(Tag::class);
    }
}
`;
  const result = parse('app/Models/Post.php', text);
  const post = result.entities[0];

  it('maps the model to its configured table with no columns', () => {
    expect(post).toMatchObject({ name: 'blog_posts', modelName: 'Post', nameCertainty: 2 });
    expect(post.columns).toEqual([]);
  });

  it('reads belongsTo / hasMany / belongsToMany with correct direction', () => {
    const bt = result.relations.find((r) => r.cardinality === 'many-to-one')!;
    expect(bt).toMatchObject({ fromColumns: ['author_id'], to: { model: 'User' } });
    const hm = result.relations.find((r) => r.cardinality === 'one-to-many')!;
    expect(hm).toMatchObject({ to: { model: 'Comment' }, toColumns: ['post_id'] });
    const m2m = result.relations.find((r) => r.cardinality === 'many-to-many')!;
    expect(m2m.to).toEqual({ model: 'Tag' });
    expect(m2m.through).toEqual({ name: 'post_tag' });
  });

  it('derives the table name by convention when $table is absent', () => {
    const user = parse('app/Models/User.php', `<?php\nclass User extends Authenticatable {\n  public function posts() { return $this->hasMany(Post::class); }\n}`);
    expect(user.entities[0]).toMatchObject({ name: 'users', modelName: 'User', nameCertainty: 0 });
  });
});

describe('laravel end-to-end', () => {
  const migration = `<?php
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('name');
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->foreignId('user_id')->constrained();
        });
    }
};`;
  const userModel = `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class User extends Model {
    public function posts() { return $this->hasMany(Post::class); }
}`;
  const postModel = `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Post extends Model {
    public function user() { return $this->belongsTo(User::class); }
}`;

  const r = resolveSchema([
    fr('database/migrations/2024_01_01_init.php', migration),
    fr('app/Models/User.php', userModel),
    fr('app/Models/Post.php', postModel),
  ]);

  it('builds users and posts and links posts → users via user_id', () => {
    expect(r.entities.map((e) => e.id)).toEqual(['posts', 'users']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.modelNames).toContain('Post');
    expect(posts.columns.find((c) => c.name === 'user_id')!.references).toMatchObject({ entity: 'users' });
    const rel = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(rel).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['user_id'], optional: false });
  });
});
