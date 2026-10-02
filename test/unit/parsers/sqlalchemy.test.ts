import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { sqlalchemyParser } from '../../../src/parsers/sqlalchemy';

const parse = (path: string, text: string) => sqlalchemyParser.parse({ path, text });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

const MODELS = `
from sqlalchemy import Column, Integer, String, Text, ForeignKey, Table, UniqueConstraint, Enum
from sqlalchemy.orm import declarative_base, relationship, Mapped, mapped_column

Base = declarative_base()

post_tags = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", Integer, ForeignKey("posts.id")),
    Column("tag_id", Integer, ForeignKey("tags.id")),
)


class TimestampMixin:
    created_at = Column(String, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column("email_address", String(255), nullable=False, unique=True)
    role = Column(Enum("admin", "user", name="user_role"))


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (UniqueConstraint("slug", name="uq_slug"), {"schema": "blog"})
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str | None] = mapped_column(Text)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    tags = relationship("Tag", secondary=post_tags, back_populates="posts")


class Tag(Base):
    __tablename__ = "tags"
    id = Column(Integer, primary_key=True)
    name = Column(String)
`;

const FLASK = `
from flask_sqlalchemy import SQLAlchemy
db = SQLAlchemy()


class Widget(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"))
`;

const MIG_1 = `
from alembic import op
import sqlalchemy as sa

revision = "0001_init"
down_revision = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("legacy", sa.Integer()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "comments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("spam", sa.Boolean()),
        sa.PrimaryKeyConstraint("id"),
    )
`;

const MIG_2 = `
from alembic import op
import sqlalchemy as sa

revision = "0002_posts"
down_revision = "0001_init"


def upgrade():
    op.create_table(
        "posts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.add_column("users", sa.Column("bio", sa.Text(), nullable=True))
    op.alter_column("users", "email", nullable=False, new_column_name="email_address")
    op.drop_column("users", "legacy")
    with op.batch_alter_table("comments") as batch_op:
        batch_op.add_column(sa.Column("edited", sa.Boolean()))
        batch_op.drop_column("spam")


def downgrade():
    op.drop_table("posts")
`;

describe('sqlalchemy detect', () => {
  it('claims SQLAlchemy, Flask-SQLAlchemy and Alembic files', () => {
    expect(sqlalchemyParser.detect({ path: 'models.py', text: MODELS })).toBe(true);
    expect(sqlalchemyParser.detect({ path: 'models.py', text: FLASK })).toBe(true);
    expect(sqlalchemyParser.detect({ path: 'versions/0001.py', text: MIG_1 })).toBe(true);
  });

  it('rejects Django and plain Python files', () => {
    expect(sqlalchemyParser.detect({ path: 'models.py', text: 'from django.db import models\nclass X(models.Model):\n    n = models.CharField(max_length=1)\n' })).toBe(false);
    expect(sqlalchemyParser.detect({ path: 'x.py', text: 'x = 1\n' })).toBe(false);
  });
});

describe('sqlalchemy declarative', () => {
  it('reads declarative columns, explicit column names, mixins and the FK with ondelete', () => {
    const r = parse('models.py', MODELS);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user.name).toBe('users');
    expect(user.nameCertainty).toBe(2);
    expect(names(user.columns)).toEqual(['id', 'email_address', 'role']);
    expect(user.columns.find((c) => c.name === 'email_address')).toMatchObject({ type: 'String(255)', nullable: false, unique: true });

    const mixin = r.entities.find((e) => e.modelName === 'TimestampMixin')!;
    expect(mixin.abstract).toBe(true);
    expect(user.extends).toEqual(['TimestampMixin']);

    const post = r.entities.find((e) => e.modelName === 'Post')!;
    expect(post.schema).toBe('blog');
    expect(names(post.columns)).toEqual(['id', 'title', 'summary', 'author_id']);
    expect(post.columns.find((c) => c.name === 'summary')).toMatchObject({ type: 'Text', nullable: true });
    expect(post.columns.find((c) => c.name === 'title')).toMatchObject({ type: 'String(200)', nullable: false });
    const fk = r.relations.find((x) => x.fromColumns[0] === 'author_id')!;
    expect(fk).toMatchObject({ from: { model: 'Post' }, to: { name: 'users' }, toColumns: ['id'], onDelete: 'CASCADE', kind: 'foreign-key' });
  });

  it('reads Core Table() definitions and relationship(secondary=…) many-to-many', () => {
    const r = parse('models.py', MODELS);
    const join = r.entities.find((e) => e.name === 'post_tags')!;
    expect(names(join.columns)).toEqual(['post_id', 'tag_id']);
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: { model: 'Post' }, to: { model: 'Tag' }, through: { name: 'post_tags' } });
  });

  it('emits enums declared inline in a column type', () => {
    const r = parse('models.py', MODELS);
    expect(r.enums).toEqual([{ name: 'user_role', values: ['admin', 'user'], source: expect.anything() }]);
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user.columns.find((c) => c.name === 'role')!.enumRef).toBe('user_role');
  });

  it('derives Flask-SQLAlchemy table names by snake_case', () => {
    const r = parse('models.py', FLASK);
    expect(r.entities[0]).toMatchObject({ name: 'widget', nameCertainty: 0, modelName: 'Widget' });
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('models.py', 'from sqlalchemy import Column\nclass Broken(Base):\n    x = Column(\n')).not.toThrow();
  });
});

describe('sqlalchemy alembic', () => {
  it('parses the upgrade direction only, with revision ordering', () => {
    const r = parse('versions/0002_posts.py', MIG_2);
    expect(r.origin).toBe('migration');
    expect(r.migration).toEqual({ id: '0002_posts', after: ['0001_init'] });
    expect(r.entities.find((e) => e.name === 'posts')).toBeTruthy();
    // downgrade's drop_table("posts") must be ignored.
    expect(r.ops?.some((o) => o.op === 'dropTable')).toBe(false);
    expect(r.ops?.find((o) => o.op === 'renameColumn')).toMatchObject({ table: { name: 'users' }, column: 'email', to: 'email_address' });
    expect(r.ops?.find((o) => o.op === 'alterColumn')).toMatchObject({ table: { name: 'users' }, column: 'email_address', set: { nullable: false } });
    expect(r.ops?.find((o) => o.op === 'dropColumn')).toMatchObject({ table: { name: 'users' }, column: 'legacy' });
  });

  it('reads batch_alter_table operations with the context table', () => {
    const r = parse('versions/0002_posts.py', MIG_2);
    expect(r.ops?.find((o) => o.op === 'dropColumn' && o.table.name === 'comments')).toMatchObject({ column: 'spam' });
    const added = r.entities.find((e) => e.name === 'comments' && e.partial);
    expect(added && names(added.columns)).toEqual(['edited']);
  });
});

describe('sqlalchemy end-to-end', () => {
  it('replays Alembic migrations into the expected schema', () => {
    const files: FileResult[] = [
      { file: 'versions/0002_posts.py', kind: 'sqlalchemy', result: parse('versions/0002_posts.py', MIG_2) },
      { file: 'versions/0001_init.py', kind: 'sqlalchemy', result: parse('versions/0001_init.py', MIG_1) },
    ];
    const r = resolveSchema(files);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(names(users.columns)).toEqual(['id', 'email_address', 'bio']);
    expect(users.columns.find((c) => c.name === 'email_address')!.nullable).toBe(false);
    const comments = r.entities.find((e) => e.id === 'comments')!;
    expect(names(comments.columns)).toEqual(['id', 'edited']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
    expect(r.relations.find((x) => x.from === 'posts')).toMatchObject({ to: 'users', fromColumns: ['author_id'], onDelete: 'CASCADE' });
  });

  it('links a declarative project end-to-end', () => {
    const r = resolveSchema([{ file: 'models.py', kind: 'sqlalchemy', result: parse('models.py', MODELS) }]);
    const ids = r.entities.filter((e) => !e.external).map((e) => e.id).sort();
    expect(ids).toEqual(['blog.posts', 'post_tags', 'tags', 'users']);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(names(users.columns)).toEqual(['created_at', 'id', 'email_address', 'role']); // mixin column copied in
    const m2m = r.relations.filter((x) => x.cardinality === 'many-to-many');
    expect(m2m).toHaveLength(1);
    expect(m2m[0]).toMatchObject({ throughName: 'post_tags' });
    expect(r.entities.find((e) => e.id === 'post_tags')!.joinTable).toBe(true);
  });
});
