import { describe, expect, it } from 'vitest';
import type { Column } from '../../../src/core/model';
import { sqlParser } from '../../../src/parsers/sql';

// Adversarial / real-dump edge cases for the SQL DDL parser.
// Each test is named after the concrete bug it locks (fixed in src/parsers/sql.ts).
const parse = (path: string, text: string) => sqlParser.parse({ path, text });
const col = (entity: { columns: Column[] } | undefined, name: string): Column | undefined =>
  entity?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

describe('sql engine detection — string / comment false positives', () => {
  // BUG: detectEngine scanned the comment-stripped view, so dialect keywords occurring only inside
  // string literals (an INSERT value, a DEFAULT, a remark) flipped the detected engine.
  it('does not infer PostgreSQL from "serial" inside a string literal', () => {
    const text = "CREATE TABLE t (id int PRIMARY KEY, note text);\nINSERT INTO t VALUES (1, 'serial number assigned');";
    expect(parse('db/schema.sql', text).engines ?? []).toEqual([]);
  });

  it('does not infer MySQL from AUTO_INCREMENT / nextval inside a DEFAULT string', () => {
    const text = "CREATE TABLE t (id int PRIMARY KEY, descr text DEFAULT 'uses AUTO_INCREMENT and nextval(seq)');";
    expect(parse('db/schema.sql', text).engines ?? []).toEqual([]);
  });

  it('still detects the engine when the keyword is real DDL (not in a string)', () => {
    const r = parse('db/schema.sql', 'CREATE TABLE t (id serial PRIMARY KEY, name text);');
    expect(r.engines?.map((e) => e.engine)).toEqual(['postgresql']);
  });
});

describe('sql engine detection — MySQL executable comments', () => {
  // BUG: a MySQL dump whose only dialect marker was a `/*!NNNNN … */` executable comment
  // (e.g. the canonical `employees` sample: no backticks, no ENGINE=, no AUTO_INCREMENT) was
  // not detected as MySQL at all.
  it('detects MySQL from a /*! … */ executable comment', () => {
    const text = [
      '/*!50503 set default_storage_engine = InnoDB */;',
      'CREATE TABLE employees (',
      '  emp_no INT NOT NULL,',
      "  gender ENUM ('M','F') NOT NULL,",
      '  PRIMARY KEY (emp_no)',
      ');',
    ].join('\n');
    const r = parse('employees.sql', text);
    expect(r.engines?.map((e) => e.engine)).toContain('mysql');
  });
});

describe('sql — unquoted keyword column names', () => {
  // BUG: `KEY` / `INDEX` are MySQL-only table-level index clauses, but they are legal (unquoted)
  // column names in PostgreSQL / SQLite / SQL Server / Oracle. A `key varchar(10)` column was
  // consumed as a phantom MySQL `KEY varchar (10)` index and the column was lost.
  it('reads unquoted key / index as columns in non-MySQL dialects', () => {
    const r = parse('db/schema.sql', 'CREATE TABLE settings (id int PRIMARY KEY, key varchar(100), value text, index int);');
    const t = r.entities.find((e) => e.name === 'settings');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'key', 'value', 'index']);
    expect(t?.indexes ?? []).toEqual([]);
    expect(col(t, 'key')?.type).toBe('varchar(100)');
  });

  it('still treats KEY / INDEX as index clauses in a MySQL file', () => {
    const text = 'CREATE TABLE `t` (`id` int, `name` varchar(20), KEY `idx_name` (`name`), UNIQUE KEY `uq_id` (`id`)) ENGINE=InnoDB;';
    const r = parse('dump.sql', text);
    const t = r.entities.find((e) => e.name === 't');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(t?.indexes?.map((i) => `${i.name}:${i.unique}`)).toEqual(['idx_name:false', 'uq_id:true']);
  });

  it('reads an anonymous KEY (cols) clause as an index even without a MySQL marker', () => {
    const r = parse('db/schema.sql', 'CREATE TABLE t (id int, name text, KEY (name));');
    const t = r.entities.find((e) => e.name === 't');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(t?.indexes?.[0]?.columns).toEqual(['name']);
  });
});

describe('sql — ALTER TABLE ADD multi-column forms', () => {
  // BUG: the MySQL / Oracle `ALTER TABLE t ADD (a …, b …)` parenthesised multi-column form was
  // parsed as nothing — every added column was dropped.
  it('reads ADD (col, col) parenthesised columns', () => {
    const r = parse('db/migrate/001_x.sql', 'ALTER TABLE t ADD (a int, b varchar(10) NOT NULL);');
    const partial = r.entities.find((e) => e.partial);
    expect(partial?.columns.map((c) => `${c.name}:${c.nullable}`)).toEqual(['a:true', 'b:false']);
  });

  it('reads ADD COLUMN (col, col) parenthesised columns', () => {
    const r = parse('db/migrate/001_x.sql', 'ALTER TABLE t ADD COLUMN (a int, b int);');
    const partial = r.entities.find((e) => e.partial);
    expect(partial?.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('still reads the comma-separated ADD COLUMN form', () => {
    const r = parse('db/migrate/001_x.sql', 'ALTER TABLE t ADD COLUMN a int, ADD COLUMN b text NOT NULL, ADD c date;');
    const partial = r.entities.find((e) => e.partial);
    expect(partial?.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('sql — robustness', () => {
  it('never throws on truncated / malformed input (watcher re-parses half-typed files)', () => {
    const inputs = [
      'CREATE TABLE t (',
      'CREATE TABLE t (a int,',
      "CREATE TABLE t (a varchar(10) DEFAULT 'unterminated",
      'ALTER TABLE t ADD',
      'ALTER TABLE t ADD (',
      'CREATE TABLE t (a int CHECK (',
      'CREATE TYPE x AS ENUM (',
    ];
    for (const t of inputs) expect(() => parse('db/schema.sql', t)).not.toThrow();
  });

  it('CRLF line endings produce the identical result to LF', () => {
    const lf = [
      'CREATE TABLE "User" (',
      '  "Id" int PRIMARY KEY,',
      '  key varchar(50),',
      '  created timestamptz DEFAULT now()',
      ');',
      'ALTER TABLE "User" ADD COLUMN (a int, b int);',
    ].join('\n');
    const a = parse('db/schema.sql', lf);
    const b = parse('db/schema.sql', lf.replace(/\n/g, '\r\n'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
