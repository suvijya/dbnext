import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { bunParser } from '../../../src/parsers/bun';

const go = (lines: string[]) => lines.join('\n');
const parse = (path: string, text: string) => bunParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'bun', result: parse(path, text) });

const modelsGo = go([
  'package models',
  '',
  'import (',
  '\t"time"',
  '\t"github.com/uptrace/bun"',
  ')',
  '',
  'type User struct {',
  '\tbun.BaseModel `bun:"table:users,alias:u"`',
  '\tID        int64     `bun:"id,pk,autoincrement"`',
  '\tName      string    `bun:"name,notnull,unique,type:varchar(100)"`',
  '\tEmail     string    `bun:",nullzero"`',
  '\tBio       string    `bun:"-"`',
  '\tCreatedAt time.Time `bun:"created_at,default:current_timestamp"`',
  '\tPosts     []*Post   `bun:"rel:has-many,join:id=author_id"`',
  '}',
  '',
  'type Post struct {',
  '\tbun.BaseModel `bun:"table:posts"`',
  '\tID       int64  `bun:"id,pk,autoincrement"`',
  '\tTitle    string `bun:"title,notnull"`',
  '\tAuthorID int64  `bun:"author_id,notnull"`',
  '\tAuthor   *User  `bun:"rel:belongs-to,join:author_id=id"`',
  '\tTags     []Tag  `bun:"m2m:post_tags,join:Post=Tag"`',
  '}',
  '',
  'type Tag struct {',
  '\tbun.BaseModel `bun:"table:tags"`',
  '\tID   int64  `bun:"id,pk,autoincrement"`',
  '\tName string `bun:"name,notnull,unique"`',
  '}',
]);

describe('bun detect', () => {
  it('claims files importing bun / using BaseModel or bun tags', () => {
    expect(bunParser.detect({ path: 'models.go', text: modelsGo })).toBe(true);
    expect(bunParser.detect({ path: 'm.go', text: 'package m\ntype T struct { ID int `bun:"id,pk"` }' })).toBe(true);
  });

  it('ignores GORM / Ent neighbours and unrelated Go', () => {
    expect(bunParser.detect({ path: 'gorm.go', text: 'package m\nimport "gorm.io/gorm"\ntype U struct { gorm.Model }' })).toBe(false);
    expect(bunParser.detect({ path: 'ent.go', text: 'package schema\nimport "entgo.io/ent"' })).toBe(false);
    expect(bunParser.detect({ path: 'main.go', text: 'package main\nfunc main() {}' })).toBe(false);
  });
});

describe('bun parse', () => {
  const result = parse('models.go', modelsGo);
  const user = result.entities.find((e) => e.modelName === 'User')!;

  it('reads the explicit table name from BaseModel tag', () => {
    expect(user.name).toBe('users');
    expect(user.nameCertainty).toBe(2);
  });

  it('maps columns, defaulting names to snake_case, nullable unless notnull/pk', () => {
    expect(user.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'created_at']);
    expect(user.columns.find((c) => c.name === 'id')).toMatchObject({ type: 'int64', primaryKey: true, nullable: false, generated: true });
    expect(user.columns.find((c) => c.name === 'name')).toMatchObject({ type: 'varchar(100)', nullable: false, unique: true });
    expect(user.columns.find((c) => c.name === 'email')).toMatchObject({ type: 'string', nullable: true });
    expect(user.columns.find((c) => c.name === 'created_at')).toMatchObject({ nullable: true, default: 'current_timestamp' });
    expect(user.columns.find((c) => c.name === 'bio')).toBeUndefined();
  });

  it('emits has-many, belongs-to and m2m relations', () => {
    const rels = result.relations;
    expect(rels.find((r) => r.from.model === 'User' && r.to.model === 'Post')).toMatchObject({ fromColumns: ['id'], toColumns: ['author_id'], cardinality: 'one-to-many' });
    expect(rels.find((r) => r.from.model === 'Post' && r.to.model === 'User')).toMatchObject({ fromColumns: ['author_id'], toColumns: ['id'], cardinality: 'many-to-one' });
    expect(rels.find((r) => r.cardinality === 'many-to-many')).toMatchObject({ from: { model: 'Post' }, to: { model: 'Tag' }, through: { name: 'post_tags' } });
  });

  it('does not throw on malformed input', () => {
    const bad = go(['package m', 'import "github.com/uptrace/bun"', 'type Broken struct {', '\tName string `bun:"name', '}']);
    expect(() => parse('bad.go', bad)).not.toThrow();
  });
});

describe('bun end-to-end', () => {
  it('resolves entities, columns and FK directions', () => {
    const r = resolveSchema([fr('models.go', modelsGo)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['posts', 'tags', 'users']);

    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.map((c) => c.name)).toEqual(['id', 'title', 'author_id']);
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });

    const fk = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(fk).toMatchObject({ fromColumns: ['author_id'], cardinality: 'many-to-one', optional: false });

    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: 'posts', to: 'tags', throughName: 'post_tags' });
  });
});
