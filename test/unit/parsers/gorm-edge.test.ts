import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { gormParser } from '../../../src/parsers/gorm';
import { bunParser } from '../../../src/parsers/bun';
import { entParser } from '../../../src/parsers/ent';

const go = (lines: string[]) => lines.join('\n');
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'gorm', result: gormParser.parse({ path, text }) });

// Found with the canonical GORM sample (go-gorm/playground models.go).
describe('gorm edge cases', () => {
  it('polymorphic associations use the <poly>_id FK column, not <parent>_id', () => {
    const text = go([
      'package models',
      'import "gorm.io/gorm"',
      'type User struct {',
      '\tgorm.Model',
      '\tName string',
      '\tToys []Toy `gorm:"polymorphic:Owner"`',
      '}',
      'type Pet struct {',
      '\tgorm.Model',
      '\tName string',
      '\tToy  Toy `gorm:"polymorphic:Owner;"`',
      '}',
      'type Toy struct {',
      '\tgorm.Model',
      '\tName      string',
      '\tOwnerID   string',
      '\tOwnerType string',
      '}',
    ]);
    const result = gormParser.parse({ path: 'models.go', text });
    // The polymorphic fields are not columns…
    const toy = result.entities.find((e) => e.modelName === 'Toy')!;
    expect(toy.columns.map((c) => c.name)).toContain('owner_id');
    for (const e of result.entities) expect(e.columns.find((c) => c.name === 'user_id' || c.name === 'pet_id')).toBeUndefined();
    // …and the relations target toys.owner_id (never a phantom users/pets FK).
    const hasMany = result.relations.find((r) => r.to.model === 'Toy' && r.cardinality === 'one-to-many')!;
    expect(hasMany).toMatchObject({ from: { model: 'User' }, toColumns: ['owner_id'] });
    const hasOne = result.relations.find((r) => r.to.model === 'Pet')!;
    expect(hasOne).toMatchObject({ from: { model: 'Toy' }, fromColumns: ['owner_id'], cardinality: 'one-to-one' });

    const resolved = resolveSchema([fr('models.go', text)]);
    expect(resolved.warnings.find((w) => /no column "(user|pet)_id"/.test(w.message))).toBeUndefined();
    const toysToUsers = resolved.relations.find((r) => r.from === 'toys' && r.to === 'users')!;
    expect(toysToUsers.fromColumns).toEqual(['owner_id']);
  });

  it('gorm:"-:all" ignores the field entirely (no phantom column)', () => {
    const text = go([
      'package m',
      'import "gorm.io/gorm"',
      'type Account struct {',
      '\tID       uint `gorm:"primaryKey"`',
      '\tName     string',
      '\tInternal string `gorm:"-:all"`',
      '\tCache    string `gorm:"-"`',
      '\tAudit    string `gorm:"-:migration"`',
      '}',
    ]);
    const account = gormParser.parse({ path: 'm.go', text }).entities.find((e) => e.modelName === 'Account')!;
    const cols = account.columns.map((c) => c.name);
    expect(cols).toContain('name');
    expect(cols).not.toContain('internal'); // -:all
    expect(cols).not.toContain('cache'); // -
    expect(cols).toContain('audit'); // -:migration keeps the column
  });

  it('xorm models (go-gitea/gitea) are not claimed by the Go ORM parsers', () => {
    const xorm = go([
      'package models',
      'import "xorm.io/xorm"',
      'type Repository struct {',
      '\tID      int64 `xorm:"pk autoincr"`',
      '\tOwnerID int64 `xorm:"INDEX"`',
      '\tName    string `xorm:"varchar(255)"`',
      '}',
    ]);
    expect(gormParser.detect({ path: 'repo.go', text: xorm })).toBe(false);
    expect(bunParser.detect({ path: 'repo.go', text: xorm })).toBe(false);
    expect(entParser.detect({ path: 'repo.go', text: xorm })).toBe(false);
  });

  it('CRLF line endings produce identical results', () => {
    const text = go([
      'package m',
      'import "gorm.io/gorm"',
      'type User struct {',
      '\tgorm.Model',
      '\tName    string `gorm:"size:120;not null"`',
      '\tCompany Company',
      '}',
      'type Company struct { ID uint `gorm:"primaryKey"`; Name string }',
    ]);
    const lf = gormParser.parse({ path: 'm.go', text });
    const crlf = gormParser.parse({ path: 'm.go', text: text.replace(/\n/g, '\r\n') });
    expect(JSON.stringify(crlf)).toEqual(JSON.stringify(lf));
  });
});
