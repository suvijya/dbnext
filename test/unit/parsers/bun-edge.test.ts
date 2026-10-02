import { describe, expect, it } from 'vitest';
import { bunParser } from '../../../src/parsers/bun';

const go = (lines: string[]) => lines.join('\n');
const parse = (path: string, text: string) => bunParser.parse({ path, text });

describe('bun edge cases', () => {
  // Found in uptrace/bun examples: belongs-to / has-many without a join: tag.
  it('defaults FK columns by convention when the join tag is omitted', () => {
    const text = go([
      'package m',
      'import "github.com/uptrace/bun"',
      'type Profile struct {',
      '\tbun.BaseModel `bun:"table:profiles"`',
      '\tID     int64 `bun:"id,pk"`',
      '\tUserID int64 `bun:"user_id"`',
      '\tUser   *User `bun:"rel:belongs-to"`',
      '}',
      'type User struct {',
      '\tbun.BaseModel `bun:"table:users"`',
      '\tID    int64  `bun:"id,pk"`',
      '\tItems []Item `bun:"rel:has-many"`',
      '}',
      'type Item struct {',
      '\tbun.BaseModel `bun:"table:items"`',
      '\tID     int64 `bun:"id,pk"`',
      '\tUserID int64 `bun:"user_id"`',
      '}',
    ]);
    const r = parse('m.go', text);
    const belongsTo = r.relations.find((x) => x.from.model === 'Profile' && x.to.model === 'User')!;
    expect(belongsTo).toMatchObject({ fromColumns: ['user_id'], cardinality: 'many-to-one' });
    const hasMany = r.relations.find((x) => x.from.model === 'User' && x.to.model === 'Item')!;
    expect(hasMany).toMatchObject({ toColumns: ['user_id'], cardinality: 'one-to-many' });
  });

  it('CRLF line endings produce identical results', () => {
    const text = go([
      'package m',
      'import "github.com/uptrace/bun"',
      'type Story struct {',
      '\tbun.BaseModel `bun:"table:stories"`',
      '\tID       int64 `bun:"id,pk,autoincrement"`',
      '\tAuthorID int64 `bun:"author_id"`',
      '\tAuthor   *Author `bun:"rel:belongs-to,join:author_id=id"`',
      '}',
    ]);
    const lf = parse('m.go', text);
    const crlf = parse('m.go', text.replace(/\n/g, '\r\n'));
    expect(JSON.stringify(crlf)).toEqual(JSON.stringify(lf));
  });
});
