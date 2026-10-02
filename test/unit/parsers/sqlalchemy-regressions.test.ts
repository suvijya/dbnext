import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { sqlalchemyParser } from '../../../src/parsers/sqlalchemy';

// Regression found while scanning gothinkster/flask-realworld-example-app (cookiecutter-flask layout).
describe('sqlalchemy parser regressions', () => {
  const database = {
    path: 'app/database.py',
    text: [
      'from sqlalchemy.orm import relationship',
      'from .extensions import db',
      '',
      'Column = db.Column',
      'Model = db.Model',
      '',
      'class SurrogatePK(object):',
      "    __table_args__ = {'extend_existing': True}",
      '    id = db.Column(db.Integer, primary_key=True)',
      '',
      "def reference_col(tablename, nullable=False, pk_name='id', **kwargs):",
      "    return db.Column(db.ForeignKey('{0}.{1}'.format(tablename, pk_name)), nullable=nullable, **kwargs)",
    ].join('\n'),
  };
  const user = {
    path: 'app/user/models.py',
    text: [
      'from app.database import Column, Model, SurrogatePK, db, reference_col, relationship',
      '',
      'class User(SurrogatePK, Model):',
      "    __tablename__ = 'users'",
      '    username = Column(db.String(80), unique=True, nullable=False)',
      '',
      'class Profile(Model, SurrogatePK):',
      "    __tablename__ = 'profiles'",
      "    user_id = reference_col('users', nullable=False)",
      "    user = relationship('User')",
      "    reviewer_id = reference_col('users', True)",
    ].join('\n'),
  };

  it('detects models that import Column/Model from a project module', () => {
    expect(sqlalchemyParser.detect(user)).toBe(true);
    expect(sqlalchemyParser.detect({ path: 'app/util.py', text: 'def f():\n    return 1\n' })).toBe(false);
  });

  it('inherits mixin columns from other files and reads reference_col foreign keys', () => {
    const r = resolveSchema([database, user].map((f) => ({ file: f.path, kind: 'sqlalchemy' as const, result: sqlalchemyParser.parse(f) })));
    expect(r.entities.map((e) => [e.id, e.columns.map((c) => c.name)])).toEqual([
      ['profiles', ['id', 'user_id', 'reviewer_id']],
      ['users', ['id', 'username']],
    ]);
    expect(r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}.${x.toColumns}:${x.optional}`)).toEqual([
      'profiles.reviewer_id>users.id:true',
      'profiles.user_id>users.id:false',
    ]);
  });
});
