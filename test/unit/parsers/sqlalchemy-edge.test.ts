import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { sqlalchemyParser } from '../../../src/parsers/sqlalchemy';

const parse = (path: string, text: string) => sqlalchemyParser.parse({ path, text });

// Found while scanning miguelgrinberg/microblog (SQLAlchemy 2.0): a `so.WriteOnlyMapped['User']`
// relationship annotation was read as a model named "WriteOnlyMapped" (via tail()), creating a
// phantom `writeonlymapped` table and a bogus `user -> writeonlymapped` many-to-many relation.
describe('sqlalchemy 2.0 relationship annotation regressions', () => {
  const text = [
    'import sqlalchemy as sa',
    'import sqlalchemy.orm as so',
    'from app import db',
    '',
    'followers = sa.Table(',
    "    'followers', db.metadata,",
    "    sa.Column('follower_id', sa.Integer, sa.ForeignKey('user.id'), primary_key=True),",
    "    sa.Column('followed_id', sa.Integer, sa.ForeignKey('user.id'), primary_key=True),",
    ')',
    '',
    'class User(db.Model):',
    '    id: so.Mapped[int] = so.mapped_column(primary_key=True)',
    "    following: so.WriteOnlyMapped['User'] = so.relationship(",
    '        secondary=followers, primaryjoin=(followers.c.follower_id == id),',
    "        secondaryjoin=(followers.c.followed_id == id), back_populates='followers')",
    "    followers: so.WriteOnlyMapped['User'] = so.relationship(",
    '        secondary=followers, primaryjoin=(followers.c.followed_id == id),',
    "        secondaryjoin=(followers.c.follower_id == id), back_populates='following')",
    '',
    'class Group(db.Model):',
    '    id: so.Mapped[int] = so.mapped_column(primary_key=True)',
    "    members: so.DynamicMapped['User'] = so.relationship(secondary=followers)",
  ].join('\n');

  it('resolves WriteOnlyMapped / DynamicMapped relationship targets to the real model', () => {
    const r = parse('app/models.py', text);
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    // Every m2m target must be a real model, never the typing wrapper.
    expect(m2m.every((x) => x.to.model === 'User')).toBe(true);
    expect(m2m.some((x) => x.to.model === 'WriteOnlyMapped' || x.to.model === 'DynamicMapped')).toBe(false);
  });

  it('does not create a phantom WriteOnlyMapped entity', () => {
    const r = resolveSchema([{ file: 'app/models.py', kind: 'sqlalchemy', result: parse('app/models.py', text) }]);
    expect(r.entities.some((e) => e.id === 'writeonlymapped' || e.id === 'dynamicmapped')).toBe(false);
    // The self-referential follower graph collapses to user <-> user through the followers table.
    const selfM2M = r.relations.find((x) => x.from === 'user' && x.to === 'user' && x.cardinality === 'many-to-many');
    expect(selfM2M?.throughName ?? selfM2M?.through).toBe('followers');
  });
});
