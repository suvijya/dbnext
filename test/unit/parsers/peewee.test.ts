import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { peeweeParser } from '../../../src/parsers/peewee';

const parse = (path: string, text: string) => peeweeParser.parse({ path, text });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

const BLOG = `
from peewee import *

db = SqliteDatabase('blog.db')


class BaseModel(Model):
    class Meta:
        database = db


class User(BaseModel):
    username = CharField(unique=True)
    email = CharField(null=True, column_name='email_address')

    class Meta:
        table_name = 'users'


class Tweet(BaseModel):
    user = ForeignKeyField(User, backref='tweets', on_delete='CASCADE')
    editor = ForeignKeyField('self', null=True)
    content = TextField()
    created = DateTimeField()
`;

describe('peewee detect', () => {
  it('claims peewee files only', () => {
    expect(peeweeParser.detect({ path: 'models.py', text: BLOG })).toBe(true);
    expect(peeweeParser.detect({ path: 'm.py', text: 'from sqlalchemy import Column\nclass X(Base):\n    id = Column(Integer)\n' })).toBe(false);
    expect(peeweeParser.detect({ path: 'm.py', text: 'from django.db import models\nclass X(models.Model):\n    n = models.CharField(max_length=1)\n' })).toBe(false);
  });
});

describe('peewee parse', () => {
  it('reads fields, Meta.table_name, column_name and implicit id', () => {
    const r = parse('models.py', BLOG);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user).toMatchObject({ name: 'users', nameCertainty: 2 });
    expect(names(user.columns)).toEqual(['id', 'username', 'email_address']);
    expect(user.columns[0]).toMatchObject({ name: 'id', primaryKey: true, type: 'AutoField', generated: true });
    expect(user.columns.find((c) => c.name === 'username')).toMatchObject({ unique: true, nullable: false });
    expect(user.columns.find((c) => c.name === 'email_address')).toMatchObject({ nullable: true });
    expect(user.extends).toEqual(['BaseModel']);
  });

  it('reads foreign keys (<name>_id columns), self references and on_delete', () => {
    const r = parse('models.py', BLOG);
    const tweet = r.entities.find((e) => e.modelName === 'Tweet')!;
    expect(names(tweet.columns)).toEqual(['id', 'user_id', 'editor_id', 'content', 'created']);
    const toUser = r.relations.find((x) => x.fromColumns[0] === 'user_id')!;
    expect(toUser).toMatchObject({ from: { model: 'Tweet' }, to: { model: 'User' }, cardinality: 'many-to-one', onDelete: 'CASCADE' });
    const toSelf = r.relations.find((x) => x.fromColumns[0] === 'editor_id')!;
    expect(toSelf).toMatchObject({ to: { model: 'Tweet' }, optional: true });
  });

  it('treats Meta-only base classes as abstract', () => {
    const r = parse('models.py', BLOG);
    expect(r.entities.find((e) => e.modelName === 'BaseModel')!.abstract).toBe(true);
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.py', 'from peewee import *\nclass A(Model):\n    x = CharField(\n')).not.toThrow();
  });
});

describe('peewee end-to-end', () => {
  it('links the blog schema', () => {
    const r = resolveSchema([{ file: 'models.py', kind: 'peewee', result: parse('models.py', BLOG) }]);
    expect(r.entities.filter((e) => !e.external).map((e) => e.id).sort()).toEqual(['tweet', 'users']);
    const tweet = r.entities.find((e) => e.id === 'tweet')!;
    expect(tweet.columns.find((c) => c.name === 'user_id')!.references).toEqual({ entity: 'users', column: 'id' });
    const rels = r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}`);
    expect(rels).toContain('tweet.user_id>users');
    expect(rels).toContain('tweet.editor_id>tweet');
  });
});
