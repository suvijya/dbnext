import { describe, expect, it } from 'vitest';
import type { Entity, SchemaModel } from '../../src/core/model';
import { column } from '../../src/core/parser';
import { toMarkdown } from '../../src/core/export';
import {
  columnNote,
  emptyNotes,
  parseNotes,
  sanitizeNotes,
  serializeNotes,
  tableNote,
  withColumnNote,
  withTableNote,
} from '../../src/core/notes';

describe('notes file', () => {
  it('survives bad JSON and wrong shapes', () => {
    expect(parseNotes('{ not json')).toEqual(emptyNotes());
    expect(parseNotes('')).toEqual(emptyNotes());
    expect(parseNotes('[1,2]')).toEqual(emptyNotes());
    expect(parseNotes('null')).toEqual(emptyNotes());
    expect(sanitizeNotes({ tables: 5, columns: 'x' })).toEqual(emptyNotes());
  });

  it('keeps only valid string notes and trims / limits them', () => {
    const n = sanitizeNotes({
      tables: { users: '  Hello  ', bad: 3, empty: '   ', __proto__x: 'ok' },
      columns: { users: { email: 'Login id', age: 7 }, orders: 'nope', ghost: {} },
    });
    expect(n.tables).toEqual({ users: 'Hello', __proto__x: 'ok' });
    expect(n.columns).toEqual({ users: { email: 'Login id' } });
    expect(sanitizeNotes({ tables: { t: 'x'.repeat(5000) } }).tables.t).toHaveLength(2000);
  });

  it('does not allow prototype pollution', () => {
    const n = parseNotes('{"tables":{"__proto__":"x","a":"b"},"columns":{"__proto__":{"c":"d"}}}');
    expect(Object.keys(n.tables)).toEqual(['a']);
    expect(({} as Record<string, unknown>).c).toBeUndefined();
    expect(Object.keys(n.columns)).toEqual([]);
  });

  it('round-trips with stable, sorted output', () => {
    let n = withTableNote(emptyNotes(), 'users', 'People');
    n = withTableNote(n, 'accounts', 'Billing');
    n = withColumnNote(n, 'users', 'email', 'Unique login');
    const text = serializeNotes(n);
    expect(text.indexOf('accounts')).toBeLessThan(text.indexOf('users'));
    expect(text.endsWith('\n')).toBe(true);
    expect(parseNotes(text)).toEqual(n);
  });

  it('setters add, replace and remove notes', () => {
    let n = withColumnNote(emptyNotes(), 'users', 'email', 'a');
    expect(columnNote(n, 'users', 'email')).toBe('a');
    n = withColumnNote(n, 'users', 'email', '  ');
    expect(n.columns).toEqual({});
    n = withTableNote(n, 'users', 'x');
    expect(tableNote(n, 'users')).toBe('x');
    expect(tableNote(n, 'constructor')).toBeUndefined();
    n = withTableNote(n, 'users', '');
    expect(n.tables).toEqual({});
  });
});

describe('notes in Markdown export', () => {
  const e: Entity = {
    id: 'users',
    name: 'users',
    kind: 'table',
    modelNames: [],
    columns: [column('id', 'int', { primaryKey: true, nullable: false }), column('email', 'text', { comment: 'schema comment' })],
    indexes: [],
    comment: 'Table comment',
    sources: ['sql'],
    files: ['schema.sql'],
    source: { file: 'schema.sql', line: 0 },
  };
  const m: SchemaModel = {
    version: 1,
    generatedAt: '2024-01-01T00:00:00Z',
    workspaceName: 'w',
    entities: [e],
    relations: [],
    enums: [],
    engines: [],
    sources: [],
    warnings: [],
    stats: { filesFound: 1, filesRead: 1, filesParsed: 1, durationMs: 1, truncated: false },
  };

  it('includes schema comments and user notes', () => {
    let notes = withTableNote(emptyNotes(), 'users', 'Owned by <team>\nsecond line');
    notes = withColumnNote(notes, 'users', 'email', 'Login | id');
    const md = toMarkdown(m, { notes });
    expect(md).toContain('Table comment');
    expect(md).toContain('> Owned by &lt;team>');
    expect(md).toContain('> second line');
    expect(md).toContain('schema comment; Note: Login \\| id');
  });

  it('is unchanged without notes', () => {
    expect(toMarkdown(m)).not.toContain('Note:');
  });
});
