import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { gormParser } from '../../../src/parsers/gorm';

// Regression found while scanning gothinkster/golang-gin-realworld-example-app.
describe('gorm parser regressions', () => {
  it('treats package-qualified model types as associations, but not value types', () => {
    const users = {
      path: 'users/models.go',
      text: 'package users\n\nimport "gorm.io/gorm"\n\ntype UserModel struct {\n\tID uint `gorm:"primaryKey"`\n\tUsername string\n}\n',
    };
    const articles = {
      path: 'articles/models.go',
      text: [
        'package articles',
        '',
        'import (',
        '\t"time"',
        '\t"github.com/acme/app/users"',
        '\t"gorm.io/gorm"',
        ')',
        '',
        'type ArticleUserModel struct {',
        '\tgorm.Model',
        '\tUserModel      users.UserModel',
        '\tUserModelID    uint',
        '\tPublishedAt    time.Time',
        '\tArchivedAt     *time.Time',
        '}',
      ].join('\n'),
    };
    const a = gormParser.parse(articles);
    const cols = a.entities.find((e) => e.modelName === 'ArticleUserModel')!.columns.map((c) => c.name);
    expect(cols).toContain('user_model_id');
    expect(cols).toContain('published_at');
    expect(cols).toContain('archived_at');
    expect(cols).not.toContain('user_model');
    const r = resolveSchema([
      { file: users.path, kind: 'gorm', result: gormParser.parse(users) },
      { file: articles.path, kind: 'gorm', result: a },
    ]);
    expect(r.relations).toEqual([
      expect.objectContaining({ from: 'article_user_models', fromColumns: ['user_model_id'], to: 'user_models', kind: 'orm', cardinality: 'many-to-one' }),
    ]);
  });
});
