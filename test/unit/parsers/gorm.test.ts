import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { gormParser } from '../../../src/parsers/gorm';

const go = (lines: string[]) => lines.join('\n');
const parse = (path: string, text: string) => gormParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'gorm', result: parse(path, text) });

const modelsGo = go([
  'package models',
  '',
  'import "gorm.io/gorm"',
  '',
  '// User is an application account.',
  'type User struct {',
  '\tgorm.Model',
  '\tName       string',
  '\tEmail      *string `gorm:"uniqueIndex;size:255;not null;column:email_address;comment:login email"`',
  '\tCompanyID  int',
  '\tCompany    Company',
  '\tCreditCards []CreditCard',
  '\tLanguages  []Language `gorm:"many2many:user_languages;"`',
  '\tProfile    Profile    `gorm:"foreignKey:UserRefer;references:ID;constraint:OnUpdate:CASCADE,OnDelete:SET NULL;"`',
  '\tSecret     string     `gorm:"-"`',
  '}',
  '',
  'type Company struct {',
  '\tID   uint `gorm:"primaryKey"`',
  '\tName string',
  '}',
  '',
  'type CreditCard struct {',
  '\tID     uint `gorm:"primaryKey;autoIncrement"`',
  '\tNumber string',
  '\tUserID uint',
  '}',
  '',
  'type Language struct {',
  '\tID   uint `gorm:"primaryKey"`',
  '\tName string',
  '}',
  '',
  'type Profile struct {',
  '\tID        uint `gorm:"primaryKey"`',
  '\tUserRefer uint',
  '\tBio       string',
  '}',
  '',
  'func (Profile) TableName() string {',
  '\treturn "member_profiles"',
  '}',
]);

describe('gorm detect', () => {
  it('claims files importing gorm or using gorm tags', () => {
    expect(gormParser.detect({ path: 'models.go', text: modelsGo })).toBe(true);
    expect(gormParser.detect({ path: 'm.go', text: 'package m\ntype T struct { ID int `gorm:"primaryKey"` }' })).toBe(true);
  });

  it('ignores neighbours (Ent, Bun) and unrelated Go', () => {
    expect(gormParser.detect({ path: 'ent.go', text: 'package schema\nimport "entgo.io/ent"\ntype User struct{ ent.Schema }' })).toBe(false);
    expect(gormParser.detect({ path: 'bun.go', text: 'package m\nimport "github.com/uptrace/bun"\ntype U struct { bun.BaseModel }' })).toBe(false);
    expect(gormParser.detect({ path: 'main.go', text: 'package main\nfunc main() {}' })).toBe(false);
  });
});

describe('gorm parse', () => {
  const result = parse('models.go', modelsGo);
  const user = result.entities.find((e) => e.modelName === 'User')!;

  it('derives the table name by convention and keeps the model name', () => {
    expect(user.name).toBe('users');
    expect(user.nameCertainty).toBe(0);
    expect(user.comment).toBe('User is an application account.');
  });

  it('expands gorm.Model and applies tag column names / types / nullability', () => {
    expect(user.columns.map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at', 'deleted_at', 'name', 'email_address', 'company_id']);
    expect(user.columns.find((c) => c.name === 'id')).toMatchObject({ type: 'uint', primaryKey: true, nullable: false, generated: true });
    expect(user.columns.find((c) => c.name === 'deleted_at')).toMatchObject({ nullable: true });
    expect(user.columns.find((c) => c.name === 'name')).toMatchObject({ type: 'string', nullable: true });
    expect(user.columns.find((c) => c.name === 'email_address')).toMatchObject({ type: 'varchar(255)', nullable: false, unique: true, comment: 'login email' });
    expect(user.columns.find((c) => c.name === 'company_id')).toMatchObject({ type: 'int', nullable: false });
  });

  it('does not create columns for association fields and honours gorm:"-"', () => {
    for (const n of ['company', 'credit_cards', 'languages', 'profile', 'secret']) {
      expect(user.columns.find((c) => c.name === n)).toBeUndefined();
    }
  });

  it('reads an explicit TableName() with certainty 2', () => {
    const profile = result.entities.find((e) => e.modelName === 'Profile')!;
    expect(profile.name).toBe('member_profiles');
    expect(profile.nameCertainty).toBe(2);
  });

  it('emits belongs-to, has-many, has-one and many2many relations', () => {
    const rels = result.relations;
    expect(rels.find((r) => r.from.model === 'User' && r.to.model === 'Company')).toMatchObject({ fromColumns: ['company_id'], cardinality: 'many-to-one' });
    expect(rels.find((r) => r.from.model === 'User' && r.to.model === 'CreditCard')).toMatchObject({ toColumns: ['user_id'], cardinality: 'one-to-many' });
    expect(rels.find((r) => r.from.model === 'Profile' && r.to.model === 'User')).toMatchObject({ fromColumns: ['user_refer'], toColumns: ['id'], cardinality: 'one-to-one', onDelete: 'SET NULL', onUpdate: 'CASCADE' });
    expect(rels.find((r) => r.cardinality === 'many-to-many')).toMatchObject({ from: { model: 'User' }, to: { model: 'Language' }, through: { name: 'user_languages' } });
  });

  it('does not throw on malformed / commented-out input', () => {
    const bad = go([
      'package m',
      'import "gorm.io/gorm"',
      '// type Ghost struct { ID int }',
      'var query = `type Fake struct { ID int }`',
      'type Broken struct {',
      '\tName string `gorm:"',
      '}',
    ]);
    expect(() => parse('bad.go', bad)).not.toThrow();
    const r = parse('bad.go', bad);
    expect(r.entities.find((e) => e.modelName === 'Ghost')).toBeUndefined();
    expect(r.entities.find((e) => e.modelName === 'Fake')).toBeUndefined();
  });
});

describe('gorm AutoMigrate confirms tagless models', () => {
  it('keeps a plain struct once AutoMigrate references it', () => {
    const types = go(['package m', 'import "gorm.io/gorm"', 'type Widget struct {', '\tID   uint', '\tName string', '}']);
    const main = go(['package m', 'import "gorm.io/gorm"', 'func migrate(db *gorm.DB) {', '\tdb.AutoMigrate(&Widget{})', '}']);
    const r = resolveSchema([fr('types.go', types), fr('main.go', main)]);
    const widget = r.entities.find((e) => e.id === 'widgets');
    expect(widget).toBeDefined();
    expect(widget!.modelNames).toContain('Widget');
    expect(widget!.columns.map((c) => c.name)).toEqual(['id', 'name']);
  });
});

describe('gorm end-to-end', () => {
  it('resolves entities, columns and relation directions a user expects', () => {
    const r = resolveSchema([fr('models.go', modelsGo)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['companies', 'credit_cards', 'languages', 'member_profiles', 'users']);

    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.columns.find((c) => c.name === 'company_id')!.references).toEqual({ entity: 'companies', column: 'id' });

    const belongsTo = r.relations.find((x) => x.from === 'users' && x.to === 'companies')!;
    expect(belongsTo).toMatchObject({ fromColumns: ['company_id'], cardinality: 'many-to-one', optional: false });

    // has-many is flipped into many-to-one on the child that holds the FK.
    const hasMany = r.relations.find((x) => x.from === 'credit_cards' && x.to === 'users')!;
    expect(hasMany).toMatchObject({ fromColumns: ['user_id'], cardinality: 'many-to-one' });

    const hasOne = r.relations.find((x) => x.from === 'member_profiles' && x.to === 'users')!;
    expect(hasOne).toMatchObject({ fromColumns: ['user_refer'], cardinality: 'one-to-one', onDelete: 'SET NULL' });

    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: 'users', to: 'languages', throughName: 'user_languages' });
  });
});
