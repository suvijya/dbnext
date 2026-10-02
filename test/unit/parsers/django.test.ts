import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { djangoParser } from '../../../src/parsers/django';

const parse = (path: string, text: string) => djangoParser.parse({ path, text });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

const BLOG = `
from django.db import models
from django.conf import settings


class Status(models.TextChoices):
    DRAFT = 'draft', 'Draft'
    PUBLISHED = 'published', 'Published'


class TimestampedModel(models.Model):
    """Reusable timestamps."""
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Author(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True, null=True)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

    class Meta:
        db_table = 'authors'


class Tag(models.Model):
    name = models.CharField(max_length=50, unique=True)


class Post(TimestampedModel):
    # commented_out = models.IntegerField()  -- must be ignored
    title = models.CharField(max_length=200, db_comment="Headline")
    slug = models.SlugField(default="n/a (class Post models.Model)")
    author = models.ForeignKey(Author, on_delete=models.CASCADE, related_name='posts')
    editor = models.ForeignKey('Author', on_delete=models.SET_NULL, null=True, related_name='edited')
    tags = models.ManyToManyField('Tag', related_name='posts')
    status = models.CharField(max_length=10, choices=Status.choices, default='draft')
`;

describe('django detect', () => {
  it('claims Django model files', () => {
    expect(djangoParser.detect({ path: 'blog/models.py', text: BLOG })).toBe(true);
  });

  it('rejects neighbours and migrations', () => {
    expect(djangoParser.detect({ path: 'm.py', text: `from sqlalchemy import Column\nclass User(Base):\n    id = Column(Integer)\n` })).toBe(false);
    expect(djangoParser.detect({ path: 'm.py', text: `from sqlmodel import SQLModel, Field\nclass Hero(SQLModel, table=True):\n    id: int = Field(primary_key=True)\n` })).toBe(false);
    expect(djangoParser.detect({ path: 'blog/migrations/0001_initial.py', text: BLOG })).toBe(false);
    expect(djangoParser.detect({ path: 'x.py', text: 'print("hello world")\n' })).toBe(false);
  });
});

describe('django parse', () => {
  it('reads fields, Meta.db_table, implicit id and the app label', () => {
    const r = parse('blog/models.py', BLOG);
    const author = r.entities.find((e) => e.modelName === 'Author')!;
    expect(author.name).toBe('authors');
    expect(author.nameCertainty).toBe(2);
    expect(author.group).toBe('blog');
    expect(names(author.columns)).toEqual(['id', 'name', 'email', 'user_id']);
    expect(author.columns[0]).toMatchObject({ name: 'id', primaryKey: true, type: 'BigAutoField', generated: true });
    expect(author.columns.find((c) => c.name === 'email')).toMatchObject({ unique: true, nullable: true });

    const tag = r.entities.find((e) => e.modelName === 'Tag')!;
    expect(tag.name).toBe('blog_tag');
    expect(tag.nameCertainty).toBe(0);
  });

  it('emits abstract bases and foreign-key columns with on_delete', () => {
    const r = parse('blog/models.py', BLOG);
    const ts = r.entities.find((e) => e.modelName === 'TimestampedModel')!;
    expect(ts.abstract).toBe(true);

    const post = r.entities.find((e) => e.modelName === 'Post')!;
    expect(post.extends).toEqual(['TimestampedModel']);
    expect(names(post.columns)).toEqual(['id', 'title', 'slug', 'author_id', 'editor_id', 'status']);
    expect(post.columns.find((c) => c.name === 'title')!.comment).toBe('Headline');

    const author = r.relations.find((x) => x.fromColumns[0] === 'author_id')!;
    expect(author).toMatchObject({ to: { model: 'Author' }, cardinality: 'many-to-one', onDelete: 'CASCADE', optional: false });
    const editor = r.relations.find((x) => x.fromColumns[0] === 'editor_id')!;
    expect(editor).toMatchObject({ onDelete: 'SET NULL', optional: true });
  });

  it('resolves AUTH_USER_MODEL / get_user_model to auth_user', () => {
    const r = parse('blog/models.py', BLOG);
    const o2o = r.relations.find((x) => x.fromColumns[0] === 'user_id')!;
    expect(o2o).toMatchObject({ to: { name: 'auth_user', model: 'User' }, cardinality: 'one-to-one' });
  });

  it('reads many-to-many with the default join table name and choices enums', () => {
    const r = parse('blog/models.py', BLOG);
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: { model: 'Post' }, to: { model: 'Tag' }, through: { name: 'blog_post_tags' } });
    expect(r.enums).toEqual([{ name: 'Status', values: ['draft', 'published'], source: expect.anything() }]);
  });

  it('ignores commented-out fields and look-alike syntax in strings', () => {
    const r = parse('blog/models.py', BLOG);
    const post = r.entities.find((e) => e.modelName === 'Post')!;
    expect(post.columns.find((c) => c.name === 'commented_out')).toBeUndefined();
    expect(post.columns.find((c) => c.name === 'slug')!.default).toContain('n/a');
  });

  it('derives the app label from models packages (apps/blog/models/post.py)', () => {
    const r = parse('apps/blog/models/post.py', `from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=1)\n`);
    expect(r.entities[0]).toMatchObject({ name: 'blog_post', group: 'blog' });
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('blog/models.py', `from django.db import models\nclass Broken(models.Model):\n    name = models.CharField(\n`)).not.toThrow();
    expect(() => parse('blog/models.py', 'class')).not.toThrow();
  });
});

describe('django end-to-end', () => {
  it('produces the entities, columns and relations a user expects', () => {
    const r = resolveSchema([{ file: 'blog/models.py', kind: 'django', result: parse('blog/models.py', BLOG) }]);
    expect(r.entities.filter((e) => !e.external).map((e) => e.id)).toEqual(['authors', 'blog_post', 'blog_tag']);

    const post = r.entities.find((e) => e.id === 'blog_post')!;
    // Abstract-base columns are copied in by the resolver.
    expect(names(post.columns)).toEqual(['created_at', 'updated_at', 'id', 'title', 'slug', 'author_id', 'editor_id', 'status']);
    expect(post.columns.find((c) => c.name === 'author_id')!.references).toEqual({ entity: 'authors', column: 'id' });
    expect(post.columns.find((c) => c.name === 'status')!.enumRef).toBe('status');

    const rels = r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}:${x.cardinality}`);
    expect(rels).toContain('blog_post.author_id>authors:many-to-one');
    expect(rels).toContain('blog_post.editor_id>authors:many-to-one');
    expect(r.relations.find((x) => x.cardinality === 'many-to-many')).toMatchObject({ from: 'blog_post', to: 'blog_tag', throughName: 'blog_post_tags' });
    expect(r.entities.find((e) => e.id === 'auth_user')).toMatchObject({ external: true });
  });
});
