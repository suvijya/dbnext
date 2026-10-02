import { describe, expect, it } from 'vitest';
import type { Column, Entity, Relation, SchemaModel } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { describeRelation, modelCounts, relationsByEntity, summaryText } from '../../src/core/format';
import { mermaidName, mermaidType, toMarkdown, toMermaid } from '../../src/core/export';

function entity(id: string, columns: Column[], extra: Partial<Entity> = {}): Entity {
  return {
    id,
    name: extra.name ?? id,
    kind: 'table',
    modelNames: [],
    columns,
    indexes: [],
    sources: ['sql'],
    files: ['schema.sql'],
    source: { file: 'schema.sql', line: 0 },
    ...extra,
  };
}

function relation(from: string, fromColumns: string[], to: string, extra: Partial<Relation> = {}): Relation {
  return {
    id: `${from}>${to}:${fromColumns.join(',')}`,
    from,
    fromColumns,
    to,
    toColumns: ['id'],
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    optional: false,
    sources: ['sql'],
    ...extra,
  };
}

const idCol = column('id', 'int', { primaryKey: true, nullable: false });

function model(entities: Entity[], relations: Relation[] = [], extra: Partial<SchemaModel> = {}): SchemaModel {
  return {
    version: 1,
    generatedAt: '2026-09-30T10:00:00.000Z',
    workspaceName: 'shop',
    entities,
    relations,
    enums: [],
    engines: [],
    sources: [{ kind: 'sql', label: 'SQL', files: 1, entities: entities.length }],
    warnings: [],
    stats: { filesFound: 10, filesRead: 10, filesParsed: 1, durationMs: 1234, truncated: false },
    ...extra,
  };
}

const users = entity('users', [idCol, column('email', 'varchar(255)', { unique: true, nullable: false, comment: 'Login "name"' })]);
const posts = entity('posts', [
  idCol,
  column('author_id', 'int', { nullable: false, references: { entity: 'users', column: 'id' } }),
  column('price', 'decimal(10, 2)'),
  column('published at', 'timestamp with time zone'),
]);

describe('mermaid tokens', () => {
  it('sanitizes types and names to what the Mermaid ER lexer accepts', () => {
    expect(mermaidType('varchar(255)')).toBe('varchar(255)');
    expect(mermaidType('decimal(10, 2)')).toBe('decimal(10-2)');
    expect(mermaidType('timestamp with time zone')).toBe('timestamp_with_time_zone');
    expect(mermaidType('"Role"[]')).toBe('Role[]');
    expect(mermaidType('Map<String, Integer>')).toBe('Map[String-Integer]');
    expect(mermaidType('sa.String')).toBe('sa_String');
    expect(mermaidType('2dsphere')).toBe('t_2dsphere');
    expect(mermaidType('')).toBe('unknown');
    expect(mermaidName('_id')).toBe('_id');
    expect(mermaidName('published at')).toBe('published_at');
    expect(mermaidName('1st')).toBe('_1st');
  });
});

describe('toMermaid', () => {
  it('renders entities, keys, comments and crow-foot markers', () => {
    const text = toMermaid(model([posts, users], [relation('posts', ['author_id'], 'users')]));
    expect(text).toBe(
      [
        'erDiagram',
        '    posts {',
        '        int id PK',
        '        int author_id FK',
        '        decimal(10-2) price',
        '        timestamp_with_time_zone published_at',
        '    }',
        '    users {',
        '        int id PK',
        `        varchar(255) email UK "Login 'name'"`,
        '    }',
        '    posts }o--|| users : "author_id"',
      ].join('\n'),
    );
  });

  it('uses optional, one-to-one, inferred and many-to-many markers; quotes unusual names', () => {
    const e = [
      entity('a', [idCol]),
      entity('b', [idCol]),
      entity('auth.users', [idCol], { name: 'users', schema: 'auth' }),
      entity('_join', [column('a_id', 'int'), column('b_id', 'int')], { name: '_join', joinTable: true }),
    ];
    const r = [
      relation('a', ['b_id'], 'b', { optional: true }),
      relation('b', ['id'], 'a', { cardinality: 'one-to-one' }),
      relation('a', ['user_id'], 'auth.users', { kind: 'inferred', optional: true }),
      relation('a', ['id'], 'b', { cardinality: 'many-to-many', through: '_join', throughName: '_join' }),
      relation('b', ['id'], 'auth.users', { cardinality: 'many-to-many', throughName: 'b_users' }),
    ];
    const text = toMermaid(model(e, r));
    expect(text).toContain('    a }o--o| b : "b_id"');
    expect(text).toContain('    b |o--|| a : "id"');
    expect(text).toContain('    a }o..o| "auth.users" : "user_id"');
    expect(text).toContain('    b }o--o{ "auth.users" : "via b_users"');
    expect(text).toContain('    "_join" {');
    expect(text).not.toContain('via _join'); // drawn through the join table instead
  });

  it('filters by entity ids, inferred and external flags', () => {
    const e = [users, posts, entity('ext', [idCol], { external: true })];
    const r = [relation('posts', ['author_id'], 'users', { kind: 'inferred' }), relation('posts', ['x'], 'ext')];
    expect(toMermaid(model(e, r), { entityIds: ['posts'] })).not.toContain('users');
    expect(toMermaid(model(e, r), { inferred: false })).not.toContain('..');
    expect(toMermaid(model(e, r), { external: false })).not.toContain('ext');
  });

  it('degrades column detail to stay under the size budget', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      entity(`t${i}`, [idCol, column(`ref_id`, 'int', { references: { entity: 'users', column: 'id' } }), ...Array.from({ length: 20 }, (_, j) => column(`col_${j}`, 'text'))]),
    );
    const m = model([users, ...many]);
    const all = toMermaid(m, { columns: 'all' });
    const keys = toMermaid(m, { maxLength: all.length - 1 });
    expect(keys).toContain('int ref_id FK');
    expect(keys).not.toContain('col_1');
    const none = toMermaid(m, { maxLength: 200 });
    expect(none).not.toContain('{');
  });
});

describe('toMarkdown', () => {
  it('produces a navigable document with diagram, tables, enums and databases', () => {
    const m = model(
      [
        users,
        posts,
        entity('auth.users', [idCol], { name: 'users', schema: 'auth' }),
        entity('legacy', [idCol], { external: true, sources: ['sql'], files: [] }),
      ],
      [relation('posts', ['author_id'], 'users')],
      {
        enums: [{ id: 'role', name: 'Role', values: ['USER', 'ADMIN'], sources: ['prisma'], source: { file: 'schema.prisma', line: 3 } }],
        engines: [{ id: 'postgresql', label: 'PostgreSQL', category: 'relational', evidence: [{ file: 'docker-compose.yml', line: 4, detail: 'image "postgres:16"' }] }],
      },
    );
    const md = toMarkdown(m, { fileLink: (ref) => `../${ref.file}#L${ref.line + 1}` });
    expect(md).toContain('# Database map: shop');
    expect(md).toContain('**3 tables · 1 relation · 1 enum**');
    expect(md).toContain('**Databases:** PostgreSQL');
    expect(md).toContain('```mermaid\nerDiagram\n');
    expect(md).toContain('| [users](#users) | table | 2 | 1 | [`schema.sql:1`](../schema.sql#L1) |');
    expect(md).toContain('| [auth.users](#authusers) |');
    expect(md).toContain('### auth.users');
    expect(md).toContain('| `author_id` | `int` |  | FK |  | users.id |  |');
    expect(md).toContain('| `email` | `varchar(255)` |  | UK |  |  | Login "name" |');
    expect(md).toContain('**References:** `author_id` → [users](#users)');
    expect(md).toContain('**Referenced by:** [posts](#posts) (`author_id`)');
    expect(md).toContain('## Referenced but not defined here');
    expect(md).toContain('| `Role` | USER, ADMIN | [`schema.prisma:4`](../schema.prisma#L4) |');
    expect(md).toContain('- **PostgreSQL** (relational): image "postgres:16" ([`docker-compose.yml:5`](../docker-compose.yml#L5))');
    expect(md).toContain('_Scanned 10 files in 1.2 s._');
  });

  it('escapes table-breaking characters and de-duplicates anchors', () => {
    const e = entity('tables', [idCol, column('a|b', 'text', { comment: 'x | <y>\nz', default: "'a|b'" })]);
    const md = toMarkdown(model([e]));
    expect(md).toContain('| `a\\|b` | `text` | yes |  | `\'a\\|b\'` |  | x \\| &lt;y> z |');
    expect(md).toContain('| [tables](#tables-1) |');
  });

  it('handles an empty model', () => {
    expect(toMarkdown(model([]))).toContain('_No database schema was detected._');
  });
});

describe('format helpers', () => {
  const m = model(
    [users, posts, entity('tags', [idCol], { kind: 'collection' }), entity('v', [], { kind: 'view' })],
    [relation('posts', ['author_id'], 'users'), relation('posts', ['id'], 'tags', { cardinality: 'many-to-many', throughName: 'post_tags' })],
  );

  it('counts and summarizes', () => {
    expect(modelCounts(m)).toMatchObject({ tables: 2, views: 1, collections: 1, relations: 2, enums: 0 });
    expect(summaryText(m)).toBe('2 tables · 1 view · 1 collection · 2 relations');
  });

  it('indexes relations per entity and describes them', () => {
    const idx = relationsByEntity(m.relations);
    expect(idx.get('posts')!.outgoing).toHaveLength(2);
    expect(idx.get('users')!.incoming).toHaveLength(1);
    expect(idx.get('tags')!.outgoing).toHaveLength(1);
    const nameOf = (id: string) => id;
    expect(describeRelation(m.relations[0], 'posts', nameOf)).toBe('author_id → users.id (many-to-one)');
    expect(describeRelation(m.relations[0], 'users', nameOf)).toBe('← posts.author_id (one-to-many)');
    expect(describeRelation(m.relations[1], 'tags', nameOf)).toBe('↔ posts via post_tags (many-to-many)');
  });
});
