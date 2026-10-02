/**
 * SQL DDL parser (all dialects + migration conventions).
 *
 * Reads `CREATE / ALTER / DROP TABLE | VIEW | TYPE | INDEX`, `COMMENT ON`, `RENAME TABLE` and
 * `EXEC sp_rename` statements from `.sql` / `.ddl` / `.cql` files written for PostgreSQL (incl.
 * pg_dump / Rails structure.sql / Supabase), MySQL / MariaDB (incl. mysqldump), SQLite, SQL Server
 * (GO batches, [brackets], sp_rename), Oracle (VARCHAR2, `/` terminators), CockroachDB, ClickHouse,
 * DuckDB, Snowflake, BigQuery and Cassandra CQL.
 *
 * Everything else (INSERT / GRANT / POLICY / FUNCTION / PROCEDURE / TRIGGER / SEQUENCE / EXTENSION…)
 * is ignored. Pure, synchronous, never throws – returns partial results on malformed input.
 */

import { emptyResult, type Column, type EngineHint, type EngineId, type ParseResult, type RawEnum, type RawRelation, type SchemaOp } from '../core/model';
import { baseName, column, extOf, pathSegments, sourceRef, type SchemaParser } from '../core/parser';
import { Code, splitQualified, stringValue, unquoteIdent } from '../core/text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Character helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isIdentStart(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 35 /* # */ || c > 127;
}
function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 35 || c > 127;
}
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Reads a (possibly qualified / quoted / bracketed) identifier from `s` starting at `i`. */
function readName(s: string, i: number, limit: number): { raw: string; end: number } | null {
  while (i < limit && isWs(s[i])) i++;
  const start = i;
  for (;;) {
    const c = s[i];
    if (c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < limit) {
        if (s[i] === q) {
          if (s[i + 1] === q) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else if (c === '[') {
      i++;
      while (i < limit && s[i] !== ']') i++;
      if (i < limit) i++;
    } else if (isIdentStart(c) || (c >= '0' && c <= '9')) {
      while (i < limit && isIdentChar(s[i])) i++;
    } else break;
    let j = i;
    while (j < limit && isWs(s[j])) j++;
    if (s[j] === '.') {
      i = j + 1;
      while (i < limit && isWs(s[i])) i++;
      continue;
    }
    break;
  }
  return i > start ? { raw: s.slice(start, i), end: i } : null;
}

/** Splits a qualified name into `{ schema, name }` keeping only the last two segments. */
function qualified(raw: string): { schema?: string; name: string } | null {
  let parts = splitQualified(raw);
  // BigQuery wraps the whole path in one backtick token: `project.dataset.table`.
  if (parts.length === 1 && parts[0].includes('.')) parts = parts[0].split('.').filter(Boolean);
  if (!parts.length) return null;
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return { schema, name };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cursor over a statement range (structure from `masked`, text from `stripped`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

class Cur {
  i: number;
  constructor(
    readonly code: Code,
    readonly s: string,
    readonly m: string,
    start: number,
    readonly end: number,
  ) {
    this.i = start;
  }
  ws(): this {
    while (this.i < this.end && isWs(this.m[this.i])) this.i++;
    return this;
  }
  done(): boolean {
    this.ws();
    return this.i >= this.end;
  }
  peek(): string {
    this.ws();
    return this.m[this.i] ?? '';
  }
  /** Consumes and returns the next bare word, or null. */
  word(): { text: string; up: string; start: number; end: number } | null {
    this.ws();
    const st = this.i;
    if (st >= this.end || !isIdentStart(this.s[st])) return null;
    let j = st + 1;
    while (j < this.end && isIdentChar(this.s[j])) j++;
    this.i = j;
    const text = this.s.slice(st, j);
    return { text, up: text.toUpperCase(), start: st, end: j };
  }
  /** Next bare word uppercased, without consuming. */
  peekWord(): string | null {
    const save = this.i;
    const w = this.word();
    this.i = save;
    return w ? w.up : null;
  }
  /** Consumes a sequence of exact keywords; rolls back and returns false on mismatch. */
  kw(...words: string[]): boolean {
    const save = this.i;
    for (const expect of words) {
      const w = this.word();
      if (!w || w.up !== expect) {
        this.i = save;
        return false;
      }
    }
    return true;
  }
  /** Consumes a balanced bracket group at the cursor; returns the open/close offsets. */
  group(): { open: number; close: number } | null {
    this.ws();
    const ch = this.m[this.i];
    if (ch !== '(' && ch !== '[' && ch !== '<' && ch !== '{') return null;
    const open = this.i;
    const close = this.code.closing(open);
    if (close < 0 || close >= this.end) {
      this.i = this.end;
      return { open, close: this.end };
    }
    this.i = close + 1;
    return { open, close };
  }
  /** Consumes a (possibly qualified) name. */
  name(): { schema?: string; name: string; start: number } | null {
    this.ws();
    const start = this.i;
    const r = readName(this.s, this.i, this.end);
    if (!r) return null;
    this.i = r.end;
    const q = qualified(r.raw);
    return q ? { ...q, start } : null;
  }
  /** Consumes a string literal (optionally preceded by `=`) and returns its value. */
  string(): string | undefined {
    this.ws();
    if (this.m[this.i] === '=') {
      this.i++;
      this.ws();
    }
    const start = this.i;
    const ch = this.m[start];
    if (ch !== "'" && ch !== '"' && ch !== '`') return undefined;
    let j = start;
    while (j < this.end && this.code.inString(j)) j++;
    this.i = Math.max(j, start + 1);
    return stringValue(this.s.slice(start, j));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyword tables
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TYPE_CONT = new Set([
  'PRECISION', 'VARYING', 'WITH', 'WITHOUT', 'TIME', 'ZONE', 'LOCAL', 'SET', 'UNSIGNED', 'SIGNED', 'ZEROFILL',
  'TO', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'CHARACTER', 'CHAR', 'NATIONAL', 'RAW', 'LONG',
]);

const DEFAULT_STOP = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'GENERATED', 'COMMENT', 'COLLATE', 'CONSTRAINT',
  'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'ON', 'AS', 'ENCODE', 'STORAGE', 'COMPRESSION', 'DEFERRABLE',
  'OPTIONS', 'KEY', 'FOREIGN', 'VISIBLE', 'INVISIBLE', 'WITH', 'CHARACTER', 'CHARSET', 'SRID', 'INITIALLY',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse context
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  file: string;
  code: Code;
  s: string;
  m: string;
  engine?: EngineId;
  entities: ParseResult['entities'];
  relations: RawRelation[];
  enums: RawEnum[];
  ops: SchemaOp[];
}

interface Table {
  name: string;
  schema?: string;
  columns: Column[];
  indexes: { name?: string; columns: string[]; unique: boolean }[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Type parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Lightly normalises a type: collapse whitespace, unwrap `[ident]` / backticks, drop space before `(`. */
function normalizeType(raw: string): string {
  let t = collapseWs(raw);
  t = t.replace(/\[([^\]]+)\]/g, '$1').replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\s+\(/g, '(');
  return t;
}

function readType(cur: Cur): { type: string; isArray: boolean; enumValues?: string[] } {
  cur.ws();
  const start = cur.i;
  let baseUp = '';
  const ch = cur.m[cur.i];
  if (ch === '[' || ch === '"' || ch === '`') {
    const r = readName(cur.s, cur.i, cur.end);
    if (!r) return { type: '', isArray: false };
    cur.i = r.end;
    baseUp = unquoteIdent(r.raw).toUpperCase();
  } else {
    const w = cur.word();
    if (!w) return { type: '', isArray: false };
    baseUp = w.up;
  }
  let isArray = false;
  let enumOpen = -1;
  for (;;) {
    const save = cur.i;
    cur.ws();
    const c = cur.m[cur.i];
    if (c === '(' || c === '<') {
      if (enumOpen < 0 && (baseUp === 'ENUM' || baseUp === 'SET')) enumOpen = cur.i;
      if (c === '<') isArray = isArray || baseUp === 'ARRAY' || baseUp === 'LIST' || baseUp === 'SET';
      const g = cur.group();
      if (!g) {
        cur.i = save;
        break;
      }
      continue;
    }
    if (c === '[') {
      const g = cur.group();
      if (!g) {
        cur.i = save;
        break;
      }
      isArray = true;
      continue;
    }
    const pw = cur.peekWord();
    if (pw && TYPE_CONT.has(pw)) {
      if (pw === 'CHARACTER' || pw === 'CHAR') {
        const save2 = cur.i;
        cur.word();
        const nxt = cur.peekWord();
        cur.i = save2;
        if (nxt === 'SET') break; // `CHARACTER SET x` is a column option, not part of the type
      }
      cur.word();
      continue;
    }
    cur.i = save;
    break;
  }
  const type = normalizeType(cur.s.slice(start, cur.i));
  let enumValues: string[] | undefined;
  if (baseUp === 'ENUM' && enumOpen >= 0) {
    enumValues = cur.code
      .items(enumOpen)
      .map((sp) => stringValue(sp.text))
      .filter((v): v is string => v !== undefined);
  }
  return { type, isArray, enumValues };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Column + constraint parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Reads a DEFAULT expression up to the next top-level constraint keyword. */
function readDefault(cur: Cur): string {
  cur.ws();
  const start = cur.i;
  let first = true;
  while (cur.i < cur.end) {
    cur.ws();
    if (cur.i >= cur.end) break;
    const c = cur.m[cur.i];
    if (c === '(' || c === '[' || c === '{') {
      if (!cur.group()) break;
      first = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = cur.i;
      while (j < cur.end && cur.code.inString(j)) j++;
      cur.i = Math.max(j, cur.i + 1);
      first = false;
      continue;
    }
    if (c === ':' && cur.m[cur.i + 1] === ':') {
      cur.i += 2;
      continue;
    }
    if (c >= '0' && c <= '9') {
      while (cur.i < cur.end && /[0-9.]/.test(cur.m[cur.i])) cur.i++;
      first = false;
      continue;
    }
    if ('+-*/%|.~<>='.includes(c)) {
      cur.i++;
      continue;
    }
    if (c === ',' || c === ')') break;
    const save = cur.i;
    const w = cur.word();
    if (!w) break;
    if (!first && DEFAULT_STOP.has(w.up)) {
      cur.i = save;
      break;
    }
    first = false;
  }
  return collapseWs(cur.s.slice(start, cur.i));
}

function readRefAction(cur: Cur): string | undefined {
  const w = cur.word();
  if (!w) return undefined;
  if (w.up === 'NO') {
    cur.kw('ACTION');
    return 'NO ACTION';
  }
  if (w.up === 'SET') {
    const n = cur.word();
    return n ? `SET ${n.up}` : 'SET';
  }
  return w.up;
}

/** Parses `REFERENCES t (cols) [MATCH …] [ON DELETE …] [ON UPDATE …]` and pushes a relation. */
function parseReferences(cur: Cur, ctx: Ctx, table: Table, fromColumns: string[], line: number, name?: string): void {
  const ref = cur.name();
  if (!ref) return;
  let toColumns: string[] = [];
  if (cur.peek() === '(') {
    const g = cur.group();
    if (g) toColumns = flattenIdents(ctx.code, g.open);
  }
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  for (let guard = 0; guard < 8 && !cur.done(); guard++) {
    if (cur.kw('MATCH')) {
      cur.word();
    } else if (cur.kw('ON', 'DELETE')) {
      onDelete = readRefAction(cur);
    } else if (cur.kw('ON', 'UPDATE')) {
      onUpdate = readRefAction(cur);
    } else if (cur.kw('NOT') || cur.kw('DEFERRABLE') || cur.kw('INITIALLY') || cur.kw('ENABLE') || cur.kw('DISABLE') || cur.kw('ENFORCED')) {
      cur.word();
    } else break;
  }
  const rel: RawRelation = {
    from: { name: table.name, schema: table.schema },
    fromColumns,
    to: { name: ref.name, schema: ref.schema },
    toColumns,
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    source: sourceRef(ctx.file, line),
  };
  if (name) rel.name = name;
  if (onDelete) rel.onDelete = onDelete;
  if (onUpdate) rel.onUpdate = onUpdate;
  ctx.relations.push(rel);
}

/** Flattens identifiers inside a bracket group, recursing into nested groups (CQL composite PK). */
function flattenIdents(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const sp of code.items(open)) {
    if (sp.text.startsWith('(')) {
      out.push(...flattenIdents(code, sp.start));
    } else {
      const r = readName(code.stripped, sp.start, sp.end);
      if (r) {
        const q = qualified(r.raw);
        if (q) out.push(q.name);
      }
    }
  }
  return out;
}

/** Index columns: simple identifiers only (drop sort options; skip expressions). */
function indexColumns(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const sp of code.items(open)) {
    if (sp.text.includes('(')) continue; // function / expression index term
    const r = readName(code.stripped, sp.start, sp.end);
    if (!r) continue;
    const q = qualified(r.raw);
    if (q) out.push(q.name);
  }
  return out;
}

/** Parses the constraint tail of a column definition into `col` (+ inline FK relations). */
function parseColumnConstraints(cur: Cur, col: Column, ctx: Ctx, table: Table, line: number): void {
  let guard = 0;
  while (!cur.done() && guard++ < 400) {
    const save = cur.i;
    const w = cur.word();
    if (!w) {
      cur.i = save + 1;
      continue;
    }
    switch (w.up) {
      case 'NOT':
        if (cur.kw('NULL')) col.nullable = false;
        break;
      case 'NULL':
        col.nullable = true;
        break;
      case 'PRIMARY':
        cur.kw('KEY');
        col.primaryKey = true;
        col.nullable = false;
        break;
      case 'UNIQUE':
        cur.kw('KEY');
        col.unique = true;
        break;
      case 'DEFAULT': {
        const d = readDefault(cur);
        if (d) col.default = d;
        if (/\bnextval\s*\(/i.test(d)) col.generated = true;
        break;
      }
      case 'GENERATED': {
        col.generated = true;
        if (!cur.kw('ALWAYS')) cur.kw('BY', 'DEFAULT');
        if (cur.kw('AS')) {
          if (cur.kw('IDENTITY')) {
            if (cur.peek() === '(') cur.group();
            col.nullable = false;
          } else {
            cur.group();
            const nx = cur.peekWord();
            if (nx === 'STORED' || nx === 'VIRTUAL' || nx === 'PERSISTED') cur.word();
          }
        }
        break;
      }
      case 'AS': {
        cur.group();
        col.generated = true;
        const nx = cur.peekWord();
        if (nx === 'STORED' || nx === 'VIRTUAL' || nx === 'PERSISTED') cur.word();
        break;
      }
      case 'AUTO_INCREMENT':
      case 'AUTOINCREMENT':
        col.generated = true;
        break;
      case 'IDENTITY':
        if (cur.peek() === '(') cur.group();
        col.generated = true;
        break;
      case 'COLLATE':
        if (!cur.name()) cur.word();
        break;
      case 'COMMENT': {
        const v = cur.string();
        if (v !== undefined) col.comment = v;
        break;
      }
      case 'REFERENCES':
        parseReferences(cur, ctx, table, [col.name], line);
        break;
      case 'CHECK':
        cur.group();
        break;
      case 'CONSTRAINT':
        if (!cur.name()) cur.word();
        break;
      case 'FOREIGN':
        cur.kw('KEY');
        cur.group();
        break;
      case 'CHARACTER':
        if (cur.kw('SET') && !cur.name()) cur.word();
        break;
      case 'CHARSET':
        if (cur.peek() === '=') cur.i++;
        if (!cur.name()) cur.word();
        break;
      case 'ON':
        cur.word(); // UPDATE / DELETE
        readDefault(cur);
        break;
      case 'ENCODE':
      case 'STORAGE':
      case 'COMPRESSION':
        if (!cur.name()) cur.word();
        break;
      case 'OPTIONS':
      case 'WITH':
        cur.group();
        break;
      case 'SRID':
        cur.word();
        break;
      case 'INITIALLY':
        cur.word();
        break;
      default:
        break;
    }
  }
}

/** Parses a single column definition from `[start,end)`; returns the column. */
function parseColumnDef(ctx: Ctx, start: number, end: number, table: Table): Column | null {
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start, end);
  const nm = cur.name();
  if (!nm) return null;
  const line = ctx.code.lineAt(nm.start);
  const col = column(nm.name, '', { source: sourceRef(ctx.file, line) });
  const t = readType(cur);
  col.type = t.type;
  if (t.isArray) col.isArray = true;
  if (/^(?:big|small)?serial\d*/i.test(t.type)) {
    col.generated = true;
    col.nullable = false;
  }
  if (t.enumValues && t.enumValues.length) {
    const enumName = `${table.name}_${nm.name}`;
    ctx.enums.push({ name: enumName, values: t.enumValues, source: sourceRef(ctx.file, line) });
    col.enumRef = enumName;
  }
  parseColumnConstraints(cur, col, ctx, table, line);
  return col;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Table constraints (inside CREATE TABLE and ALTER TABLE ADD)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Optional index name before the `(columns)` of a MySQL `KEY` / `UNIQUE KEY`. */
function optionalIndexName(cur: Cur): string | undefined {
  if (cur.peek() === '(') return undefined;
  const nm = cur.name();
  return nm?.name;
}

/** Parses a table-level constraint item (PRIMARY KEY / UNIQUE / FOREIGN KEY / KEY / CHECK / …). */
function parseTableConstraint(cur: Cur, keyword: string, name: string | undefined, ctx: Ctx, table: Table, line: number): void {
  switch (keyword) {
    case 'PRIMARY': {
      cur.kw('PRIMARY', 'KEY') || cur.kw('PRIMARY');
      cur.kw('CLUSTERED') || cur.kw('NONCLUSTERED');
      const g = cur.group();
      if (g) {
        for (const c of flattenIdents(ctx.code, g.open)) {
          const found = table.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
          if (found) {
            found.primaryKey = true;
            found.nullable = false;
          }
        }
      }
      break;
    }
    case 'UNIQUE': {
      cur.word(); // UNIQUE
      cur.kw('KEY') || cur.kw('INDEX');
      const nm = name ?? optionalIndexName(cur);
      const g = cur.group();
      if (g) {
        const cols = flattenIdents(ctx.code, g.open);
        if (cols.length) {
          table.indexes.push({ name: nm, columns: cols, unique: true });
          if (cols.length === 1) {
            const found = table.columns.find((x) => x.name.toLowerCase() === cols[0].toLowerCase());
            if (found) found.unique = true;
          }
        }
      }
      break;
    }
    case 'FOREIGN': {
      cur.kw('FOREIGN', 'KEY');
      optionalIndexName(cur); // MySQL symbol name
      const g = cur.group();
      const fromColumns = g ? flattenIdents(ctx.code, g.open) : [];
      if (cur.kw('REFERENCES') && fromColumns.length) parseReferences(cur, ctx, table, fromColumns, line, name);
      break;
    }
    case 'KEY':
    case 'INDEX': {
      cur.word();
      const nm = optionalIndexName(cur);
      const g = cur.group();
      if (g) {
        const cols = flattenIdents(ctx.code, g.open);
        if (cols.length) table.indexes.push({ name: nm, columns: cols, unique: false });
      }
      break;
    }
    case 'FULLTEXT':
    case 'SPATIAL': {
      cur.word();
      cur.kw('KEY') || cur.kw('INDEX');
      const nm = optionalIndexName(cur);
      const g = cur.group();
      if (g) {
        const cols = flattenIdents(ctx.code, g.open);
        if (cols.length) table.indexes.push({ name: nm, columns: cols, unique: false });
      }
      break;
    }
    default:
      break; // CHECK, EXCLUDE, PERIOD, … ignored
  }
}

const TABLE_CONSTRAINT_HEADS = new Set(['PRIMARY', 'UNIQUE', 'FOREIGN', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'CHECK', 'EXCLUDE', 'PERIOD', 'CONSTRAINT']);

function isMysqlDialect(ctx: Ctx): boolean {
  return ctx.engine === 'mysql' || ctx.engine === 'mariadb';
}

/**
 * Should a leading `KEY` / `INDEX` word be read as a table-level index clause rather than a column?
 * `KEY (cols)` / `INDEX name (cols)` is MySQL-only; in PostgreSQL, SQLite, SQL Server, Oracle… `key`
 * and `index` are perfectly legal (unquoted) column names (`key text`, `index int`). So treat them as
 * a constraint only in a MySQL/MariaDB file, or when the word is immediately followed by `(` (an
 * anonymous `KEY (cols)` index — which cannot be a column definition in any dialect).
 */
function isConstraintHead(ctx: Ctx, start: Cur, first: string): boolean {
  if (first !== 'KEY' && first !== 'INDEX') return true;
  if (isMysqlDialect(ctx)) return true;
  const probe = new Cur(ctx.code, ctx.s, ctx.m, start.i, start.end);
  probe.word(); // consume KEY / INDEX
  return probe.peek() === '(';
}

function parseTableItem(ctx: Ctx, start: number, end: number, table: Table, line: number): void {
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start, end);
  const first = cur.peekWord();
  if (first && TABLE_CONSTRAINT_HEADS.has(first) && isConstraintHead(ctx, cur, first)) {
    let name: string | undefined;
    let head = first;
    if (first === 'CONSTRAINT') {
      cur.word();
      name = cur.name()?.name;
      head = cur.peekWord() ?? '';
    }
    parseTableConstraint(cur, head, name, ctx, table, line);
    return;
  }
  const col = parseColumnDef(ctx, start, end, table);
  if (col) table.columns.push(col);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Statement handlers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RE_CREATE_TABLE =
  /^CREATE\s+(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMP(?:ORARY)?|UNLOGGED|TRANSIENT|VOLATILE|EXTERNAL|FOREIGN|DYNAMIC|SET|MULTISET|VIRTUAL|SHADOW|COLUMN|ROW)\s+)*TABLE\b(?:\s+IF\s+NOT\s+EXISTS)?\s*/i;
const RE_CREATE_VIEW =
  /^CREATE\s+(?:(?:OR\s+REPLACE|TEMP(?:ORARY)?|MATERIALIZED|RECURSIVE|SECURE|GLOBAL|LOCAL|VOLATILE|FORCE|NONFORCE)\s+)*VIEW\b(?:\s+IF\s+NOT\s+EXISTS)?\s*/i;
const RE_CREATE_INDEX =
  /^CREATE\s+(?:(?:UNIQUE|CLUSTERED|NONCLUSTERED|FULLTEXT|SPATIAL|BITMAP|OR\s+REPLACE|SEARCH)\s+)*INDEX\b(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s*/i;
const RE_CREATE_TYPE = /^CREATE\s+TYPE\b\s*/i;
const RE_ALTER_TABLE = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?/i;
const RE_ALTER_TYPE = /^ALTER\s+TYPE\s+/i;
const RE_DROP_TABLE = /^DROP\s+(?:MATERIALIZED\s+)?(TABLE|VIEW)\b(?:\s+IF\s+EXISTS)?\s*/i;
const RE_DROP_TYPE = /^DROP\s+TYPE\b(?:\s+IF\s+EXISTS)?\s*/i;
const RE_COMMENT_ON = /^COMMENT\s+ON\s+(TABLE|COLUMN|VIEW|MATERIALIZED\s+VIEW)\s+/i;
const RE_RENAME_TABLE = /^RENAME\s+TABLE\s+/i;
const RE_SP_RENAME = /^EXEC(?:UTE)?\s+(?:dbo\s*\.\s*)?sp_rename\b\s*/i;

function parseCreateTable(ctx: Ctx, start: number, end: number): void {
  const head = ctx.s.slice(start, Math.min(end, start + 200));
  const m = RE_CREATE_TABLE.exec(head);
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const nm = cur.name();
  if (!nm) return;
  const pw = cur.peekWord();
  if (pw === 'AS' || pw === 'PARTITION' || pw === 'LIKE' || pw === 'OF') return; // CTAS / inheritance / typed table
  const table: Table = { name: nm.name, schema: nm.schema, columns: [], indexes: [] };
  let comment: string | undefined;
  if (cur.peek() === '(') {
    const g = cur.group();
    if (g) {
      // CQL / BigQuery types use `<…>` generics whose commas must not split columns; those dialects
      // have no `<` comparison in CHECK constraints, so treating angles as brackets is safe there.
      const angle = ctx.engine === 'cassandra' || ctx.engine === 'bigquery';
      for (const sp of ctx.code.split(g.open + 1, g.close, ',', { angle })) {
        if (/^LIKE\b/i.test(sp.text)) continue; // (LIKE other) clone
        parseTableItem(ctx, sp.start, sp.end, table, ctx.code.lineAt(sp.start));
      }
      // table options after the column list (ENGINE=, COMMENT='…', WITH comment=…)
      const opts = new Cur(ctx.code, ctx.s, ctx.m, g.close + 1, end);
      let guard = 0;
      while (!opts.done() && guard++ < 200) {
        const w = opts.word();
        if (!w) {
          opts.i++;
          continue;
        }
        if (w.up === 'COMMENT') {
          const v = opts.string();
          if (v !== undefined) comment = v;
        }
      }
    }
  }
  ctx.entities.push({
    name: table.name,
    schema: table.schema,
    kind: 'table',
    columns: table.columns,
    ...(table.indexes.length ? { indexes: table.indexes.map((ix) => ({ ...ix, source: sourceRef(ctx.file, ctx.code.lineAt(start)) })) } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(ctx.engine ? { engine: ctx.engine } : {}),
    source: sourceRef(ctx.file, ctx.code.lineAt(start)),
  });
}

function parseCreateView(ctx: Ctx, start: number, end: number): void {
  const head = ctx.s.slice(start, Math.min(end, start + 200));
  const m = RE_CREATE_VIEW.exec(head);
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const nm = cur.name();
  if (!nm) return;
  const columns: Column[] = [];
  if (cur.peek() === '(') {
    const g = cur.group();
    if (g) for (const c of flattenIdents(ctx.code, g.open)) columns.push(column(c, ''));
  }
  if (!columns.length) {
    // Cheap select-list parse: AS SELECT <list> FROM …
    const rest = ctx.m.slice(cur.i, end);
    const asIdx = /\bAS\b/i.exec(rest);
    const selMatch = /\bSELECT\b/i.exec(rest);
    if (selMatch) {
      const selStart = cur.i + selMatch.index + selMatch[0].length;
      const fromMatch = /\bFROM\b/i.exec(ctx.m.slice(selStart, end));
      const selEnd = fromMatch ? selStart + fromMatch.index : end;
      if (asIdx === null || selMatch.index >= asIdx.index) {
        for (const sp of ctx.code.split(selStart, selEnd, ',')) {
          const c = viewSelectAlias(ctx.code, sp.start, sp.end);
          if (c) columns.push(column(c, ''));
        }
      }
    }
  }
  ctx.entities.push({
    name: nm.name,
    schema: nm.schema,
    kind: 'view',
    columns,
    ...(ctx.engine ? { engine: ctx.engine } : {}),
    source: sourceRef(ctx.file, ctx.code.lineAt(start)),
  });
}

/** Extracts the output column of a view select-list item, or null for `*` / complex expressions. */
function viewSelectAlias(code: Code, start: number, end: number): string | null {
  const text = code.slice(start, end).trim();
  if (!text || text === '*' || text.endsWith('.*')) return null;
  const asMatch = /\bAS\s+([A-Za-z_][\w$]*|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])\s*$/i.exec(text);
  if (asMatch) return unquoteIdent(asMatch[1]);
  // trailing alias without AS: `expr alias`
  const tail = /(?:^|[\s.)])([A-Za-z_][\w$]*|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])\s*$/.exec(text);
  if (/[()+\-*/]/.test(text) && !asMatch) {
    // expression without explicit alias → not a clean column
    if (!/^[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?$/.test(text)) return null;
  }
  if (/^[A-Za-z_][\w$"'`[\].]+$/.test(text)) {
    const r = readName(code.stripped, start, end);
    if (r) {
      const q = qualified(r.raw);
      if (q) return q.name;
    }
  }
  return tail ? unquoteIdent(tail[1]) : null;
}

function parseCreateIndex(ctx: Ctx, start: number, end: number): void {
  const head = ctx.s.slice(start, Math.min(end, start + 200));
  const m = RE_CREATE_INDEX.exec(head);
  if (!m) return;
  const unique = /\bUNIQUE\b/i.test(m[0]);
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  let indexName: string | undefined;
  if (cur.peekWord() !== 'ON') indexName = cur.name()?.name;
  if (!cur.kw('ON')) return;
  const tbl = cur.name();
  if (!tbl) return;
  if (cur.kw('USING')) cur.word();
  if (cur.peek() !== '(') return;
  const g = cur.group();
  if (!g) return;
  const cols = indexColumns(ctx.code, g.open);
  if (!cols.length) return;
  ctx.entities.push({
    name: tbl.name,
    schema: tbl.schema,
    kind: 'table',
    partial: true,
    columns: [],
    indexes: [{ name: indexName, columns: cols, unique, source: sourceRef(ctx.file, ctx.code.lineAt(start)) }],
    source: sourceRef(ctx.file, ctx.code.lineAt(start)),
  });
}

function parseCreateType(ctx: Ctx, start: number, end: number): void {
  const m = RE_CREATE_TYPE.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const nm = cur.name();
  if (!nm) return;
  if (cur.kw('AS') && cur.kw('ENUM')) {
    const g = cur.group();
    if (g) {
      const values = ctx.code
        .items(g.open)
        .map((sp) => stringValue(sp.text))
        .filter((v): v is string => v !== undefined);
      ctx.enums.push({ name: nm.name, schema: nm.schema, values, source: sourceRef(ctx.file, ctx.code.lineAt(start)) });
    }
  }
  // CQL `CREATE TYPE` (UDT), composite / range types → ignored
}

function parseAlterType(ctx: Ctx, start: number, end: number): void {
  const m = RE_ALTER_TYPE.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const nm = cur.name();
  if (!nm) return;
  const line = ctx.code.lineAt(start);
  if (cur.kw('ADD')) {
    cur.kw('VALUE');
    cur.kw('IF', 'NOT', 'EXISTS');
    const v = cur.string();
    if (v !== undefined) ctx.enums.push({ name: nm.name, schema: nm.schema, values: [v], partial: true, source: sourceRef(ctx.file, line) });
  } else if (cur.kw('RENAME')) {
    if (cur.kw('TO')) {
      const to = cur.name()?.name;
      if (to) ctx.ops.push({ op: 'renameEnum', name: nm.name, schema: nm.schema, to, source: sourceRef(ctx.file, line) });
    }
  }
}

function parseDropTableView(ctx: Ctx, start: number, end: number): void {
  const m = RE_DROP_TABLE.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const line = ctx.code.lineAt(start);
  let guard = 0;
  while (!cur.done() && guard++ < 200) {
    const pw = cur.peekWord();
    if (pw === 'CASCADE' || pw === 'RESTRICT') break;
    const nm = cur.name();
    if (!nm) break;
    ctx.ops.push({ op: 'dropTable', table: { name: nm.name, schema: nm.schema }, source: sourceRef(ctx.file, line) });
    if (cur.peek() === ',') cur.i++;
    else break;
  }
}

function parseDropType(ctx: Ctx, start: number, end: number): void {
  const m = RE_DROP_TYPE.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const line = ctx.code.lineAt(start);
  let guard = 0;
  while (!cur.done() && guard++ < 200) {
    const pw = cur.peekWord();
    if (pw === 'CASCADE' || pw === 'RESTRICT') break;
    const nm = cur.name();
    if (!nm) break;
    ctx.ops.push({ op: 'dropEnum', name: nm.name, schema: nm.schema, source: sourceRef(ctx.file, line) });
    if (cur.peek() === ',') cur.i++;
    else break;
  }
}

function parseCommentOn(ctx: Ctx, start: number, end: number): void {
  const m = RE_COMMENT_ON.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const target = m[1].toUpperCase().replace(/\s+/g, ' ');
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const line = ctx.code.lineAt(start);
  if (target === 'COLUMN') {
    const nm = cur.name();
    if (!nm) return;
    const parts = splitQualified(readName(ctx.s, nm.start, end)?.raw ?? '');
    if (parts.length < 2) return;
    const col = parts[parts.length - 1];
    const tbl = parts[parts.length - 2];
    const schema = parts.length >= 3 ? parts[parts.length - 3] : undefined;
    if (!cur.kw('IS')) return;
    const v = cur.string();
    if (v !== undefined) ctx.ops.push({ op: 'alterColumn', table: { name: tbl, schema }, column: col, set: { comment: v }, source: sourceRef(ctx.file, line) });
  } else {
    const nm = cur.name();
    if (!nm) return;
    if (!cur.kw('IS')) return;
    const v = cur.string();
    if (v !== undefined) {
      ctx.entities.push({ name: nm.name, schema: nm.schema, kind: target.includes('VIEW') ? 'view' : 'table', partial: true, columns: [], comment: v, source: sourceRef(ctx.file, line) });
    }
  }
}

function parseRenameTable(ctx: Ctx, start: number, end: number): void {
  const m = RE_RENAME_TABLE.exec(ctx.s.slice(start, Math.min(end, start + 40)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const line = ctx.code.lineAt(start);
  let guard = 0;
  while (!cur.done() && guard++ < 200) {
    const from = cur.name();
    if (!from) break;
    if (!cur.kw('TO')) break;
    const to = cur.name();
    if (!to) break;
    ctx.ops.push({ op: 'renameTable', table: { name: from.name, schema: from.schema }, to: to.name, source: sourceRef(ctx.file, line) });
    if (cur.peek() === ',') cur.i++;
    else break;
  }
}

function parseSpRename(ctx: Ctx, start: number, end: number): void {
  const m = RE_SP_RENAME.exec(ctx.s.slice(start, Math.min(end, start + 40)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  if (cur.peek() === '(') cur.i++;
  const oldName = cur.string();
  if (oldName === undefined) return;
  if (cur.peek() === ',') cur.i++;
  const newName = cur.string();
  if (newName === undefined) return;
  let type: string | undefined;
  if (cur.peek() === ',') {
    cur.i++;
    type = cur.string()?.toUpperCase();
  }
  const line = ctx.code.lineAt(start);
  if (type === 'COLUMN') {
    const parts = splitQualified(oldName);
    if (parts.length < 2) return;
    const col = parts[parts.length - 1];
    const tbl = parts[parts.length - 2];
    const schema = parts.length >= 3 ? parts[parts.length - 3] : undefined;
    ctx.ops.push({ op: 'renameColumn', table: { name: tbl, schema }, column: col, to: splitQualified(newName).pop() ?? newName, source: sourceRef(ctx.file, line) });
  } else if (!type || type === 'OBJECT') {
    const q = qualified(oldName);
    if (q) ctx.ops.push({ op: 'renameTable', table: { name: q.name, schema: q.schema }, to: splitQualified(newName).pop() ?? newName, source: sourceRef(ctx.file, line) });
  }
}

// ── ALTER TABLE ──────────────────────────────────────────────────────────────────────────────

function parseAlterTable(ctx: Ctx, start: number, end: number): void {
  const m = RE_ALTER_TABLE.exec(ctx.s.slice(start, Math.min(end, start + 60)));
  if (!m) return;
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start + m[0].length, end);
  const nm = cur.name();
  if (!nm) return;
  const table: Table = { name: nm.name, schema: nm.schema, columns: [], indexes: [] };
  const line = ctx.code.lineAt(start);
  // SQL Server: optional `WITH [NO]CHECK` before ADD
  if (cur.kw('WITH')) cur.word();
  const partialColumns: Column[] = [];
  for (const sp of ctx.code.split(cur.i, end, ',')) {
    parseAlterAction(ctx, sp.start, sp.end, table, line, partialColumns);
  }
  if (partialColumns.length || table.indexes.length) {
    ctx.entities.push({
      name: table.name,
      schema: table.schema,
      kind: 'table',
      partial: true,
      columns: partialColumns,
      ...(table.indexes.length ? { indexes: table.indexes.map((ix) => ({ ...ix, source: sourceRef(ctx.file, line) })) } : {}),
      source: sourceRef(ctx.file, line),
    });
  }
}

function parseAlterAction(ctx: Ctx, start: number, end: number, table: Table, line: number, partialColumns: Column[]): void {
  const cur = new Cur(ctx.code, ctx.s, ctx.m, start, end);
  const head = cur.peekWord();
  switch (head) {
    case 'ADD':
      cur.word();
      parseAddAction(ctx, cur, end, table, line, partialColumns);
      break;
    case 'DROP':
      cur.word();
      parseDropAction(ctx, cur, table, line);
      break;
    case 'ALTER':
      cur.word();
      parseAlterColumnAction(ctx, cur, table, line);
      break;
    case 'RENAME':
      cur.word();
      parseRenameAction(ctx, cur, table, line);
      break;
    case 'MODIFY':
      cur.word();
      parseModifyAction(ctx, cur, table, line, false);
      break;
    case 'CHANGE':
      cur.word();
      parseModifyAction(ctx, cur, table, line, true);
      break;
    default:
      break; // OWNER / SET / ENABLE / DISABLE / VALIDATE / CLUSTER / INHERIT / CHECK / NOCHECK …
  }
}

function parseAddAction(ctx: Ctx, cur: Cur, end: number, table: Table, line: number, partialColumns: Column[]): void {
  cur.kw('COLUMN');
  cur.kw('IF', 'NOT', 'EXISTS');
  // MySQL `ADD (a int, b int)` / `ADD COLUMN (a int, b int)`: a parenthesised list of columns.
  if (cur.peek() === '(') {
    const g = cur.group();
    if (g) {
      for (const sp of ctx.code.split(g.open + 1, g.close, ',')) {
        const col = parseColumnDef(ctx, sp.start, sp.end, table);
        if (col) {
          partialColumns.push(col);
          table.columns.push(col);
        }
      }
    }
    return;
  }
  const k = cur.peekWord();
  if (k === 'CONSTRAINT') {
    cur.word();
    const name = cur.name()?.name;
    parseAddConstraint(ctx, cur, cur.peekWord() ?? '', name, table, line);
    return;
  }
  // `KEY` / `INDEX` are MySQL-only index clauses; elsewhere they are legal column names (`ADD key int`).
  const indexWord = k === 'KEY' || k === 'INDEX';
  const treatAsConstraint =
    k !== null &&
    ['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'EXCLUDE'].includes(k) &&
    (!indexWord || isMysqlDialect(ctx));
  if (treatAsConstraint) {
    parseAddConstraint(ctx, cur, k, undefined, table, line);
    return;
  }
  // Add a column (standard `ADD COLUMN c …` and SQL Server `ADD c …`)
  const col = parseColumnDef(ctx, cur.i, end, table);
  if (col) {
    partialColumns.push(col);
    table.columns.push(col);
  }
}

function parseAddConstraint(ctx: Ctx, cur: Cur, kind: string, name: string | undefined, table: Table, line: number): void {
  switch (kind) {
    case 'PRIMARY': {
      cur.kw('PRIMARY', 'KEY') || cur.kw('PRIMARY');
      cur.kw('CLUSTERED') || cur.kw('NONCLUSTERED');
      const g = cur.group();
      if (g) for (const c of flattenIdents(ctx.code, g.open)) ctx.ops.push({ op: 'alterColumn', table: { name: table.name, schema: table.schema }, column: c, set: { primaryKey: true }, source: sourceRef(ctx.file, line) });
      break;
    }
    case 'UNIQUE': {
      cur.word();
      cur.kw('KEY') || cur.kw('INDEX');
      const nm = name ?? optionalIndexName(cur);
      const g = cur.group();
      if (g) {
        const cols = flattenIdents(ctx.code, g.open);
        if (cols.length) table.indexes.push({ name: nm, columns: cols, unique: true });
      }
      break;
    }
    case 'FOREIGN': {
      cur.kw('FOREIGN', 'KEY');
      optionalIndexName(cur);
      const g = cur.group();
      const fromColumns = g ? flattenIdents(ctx.code, g.open) : [];
      if (cur.kw('REFERENCES') && fromColumns.length) parseReferences(cur, ctx, table, fromColumns, line, name);
      break;
    }
    case 'KEY':
    case 'INDEX': {
      cur.word();
      const nm = optionalIndexName(cur);
      const g = cur.group();
      if (g) {
        const cols = flattenIdents(ctx.code, g.open);
        if (cols.length) table.indexes.push({ name: nm, columns: cols, unique: false });
      }
      break;
    }
    default:
      break; // CHECK / EXCLUDE ignored
  }
}

function parseDropAction(ctx: Ctx, cur: Cur, table: Table, line: number): void {
  const k = cur.peekWord();
  if (k === 'COLUMN') {
    cur.word();
    cur.kw('IF', 'EXISTS');
    const nm = cur.name();
    if (nm) ctx.ops.push({ op: 'dropColumn', table: { name: table.name, schema: table.schema }, column: nm.name, source: sourceRef(ctx.file, line) });
  } else if (k === 'CONSTRAINT') {
    cur.word();
    cur.kw('IF', 'EXISTS');
    const nm = cur.name();
    if (nm) ctx.ops.push({ op: 'dropForeignKey', table: { name: table.name, schema: table.schema }, name: nm.name, source: sourceRef(ctx.file, line) });
  } else if (k === 'FOREIGN') {
    cur.kw('FOREIGN', 'KEY');
    const nm = cur.name();
    if (nm) ctx.ops.push({ op: 'dropForeignKey', table: { name: table.name, schema: table.schema }, name: nm.name, source: sourceRef(ctx.file, line) });
  }
  // DROP PRIMARY KEY / DROP INDEX / DROP KEY → not representable, ignored
}

function parseAlterColumnAction(ctx: Ctx, cur: Cur, table: Table, line: number): void {
  cur.kw('COLUMN');
  const nm = cur.name();
  if (!nm) return;
  const patch: NonNullable<Extract<SchemaOp, { op: 'alterColumn' }>['set']> = {};
  const k = cur.peekWord();
  if (k === 'SET') {
    cur.word();
    const k2 = cur.peekWord();
    if (k2 === 'NOT') {
      cur.kw('NOT', 'NULL');
      patch.nullable = false;
    } else if (k2 === 'DEFAULT') {
      cur.word();
      const d = readDefault(cur);
      if (d) {
        patch.default = d;
        if (/\bnextval\s*\(/i.test(d)) patch.generated = true;
      }
    } else if (k2 === 'DATA') {
      cur.kw('DATA', 'TYPE');
      const t = readType(cur);
      if (t.type) patch.type = t.type;
    } else if (k2 === 'NULL') {
      cur.word();
      patch.nullable = true;
    }
  } else if (k === 'DROP') {
    cur.word();
    if (cur.kw('NOT', 'NULL')) patch.nullable = true;
  } else if (k === 'TYPE') {
    cur.word();
    const t = readType(cur);
    if (t.type) patch.type = t.type;
  } else if (k === 'ADD') {
    cur.word();
    if (cur.peekWord() === 'GENERATED') patch.generated = true;
  } else {
    // SQL Server: ALTER COLUMN c <type> [NULL|NOT NULL]
    const t = readType(cur);
    if (t.type) patch.type = t.type;
    let guard = 0;
    while (!cur.done() && guard++ < 50) {
      const w = cur.word();
      if (!w) break;
      if (w.up === 'NOT') {
        cur.kw('NULL');
        patch.nullable = false;
      } else if (w.up === 'NULL') patch.nullable = true;
      else if (w.up === 'IDENTITY') {
        if (cur.peek() === '(') cur.group();
        patch.generated = true;
      }
    }
  }
  if (Object.keys(patch).length) ctx.ops.push({ op: 'alterColumn', table: { name: table.name, schema: table.schema }, column: nm.name, set: patch, source: sourceRef(ctx.file, line) });
}

function parseRenameAction(ctx: Ctx, cur: Cur, table: Table, line: number): void {
  const k = cur.peekWord();
  if (k === 'COLUMN') {
    cur.word();
    const from = cur.name()?.name;
    if (!(cur.kw('TO') || cur.kw('AS'))) return;
    const to = cur.name()?.name;
    if (from && to) ctx.ops.push({ op: 'renameColumn', table: { name: table.name, schema: table.schema }, column: from, to, source: sourceRef(ctx.file, line) });
  } else if (k === 'TO' || k === 'AS') {
    cur.word();
    const to = cur.name()?.name;
    if (to) ctx.ops.push({ op: 'renameTable', table: { name: table.name, schema: table.schema }, to, source: sourceRef(ctx.file, line) });
  } else if (k === 'CONSTRAINT' || k === 'INDEX' || k === 'KEY') {
    // not representable
  }
}

function parseModifyAction(ctx: Ctx, cur: Cur, table: Table, line: number, change: boolean): void {
  cur.kw('COLUMN');
  const first = cur.name();
  if (!first) return;
  let columnName = first.name;
  let renameTo: string | undefined;
  if (change) {
    const next = cur.name();
    if (!next) return;
    renameTo = next.name;
  }
  const t = readType(cur);
  const tmp = column(renameTo ?? columnName, '', { nullable: true });
  if (t.type) tmp.type = t.type;
  if (t.isArray) tmp.isArray = true;
  parseColumnConstraints(cur, tmp, ctx, table, line);

  if (change && renameTo && renameTo.toLowerCase() !== columnName.toLowerCase()) {
    ctx.ops.push({ op: 'renameColumn', table: { name: table.name, schema: table.schema }, column: columnName, to: renameTo, source: sourceRef(ctx.file, line) });
    columnName = renameTo;
  }
  const patch: NonNullable<Extract<SchemaOp, { op: 'alterColumn' }>['set']> = { nullable: tmp.nullable };
  if (tmp.type) patch.type = tmp.type;
  if (tmp.default !== undefined) patch.default = tmp.default;
  if (tmp.generated !== undefined) patch.generated = tmp.generated;
  if (tmp.comment !== undefined) patch.comment = tmp.comment;
  if (tmp.isArray !== undefined) patch.isArray = tmp.isArray;
  ctx.ops.push({ op: 'alterColumn', table: { name: table.name, schema: table.schema }, column: columnName, set: patch, source: sourceRef(ctx.file, line) });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Statement splitting (delimiter / GO / Oracle `/` aware)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function splitStatements(code: Code): { start: number; end: number }[] {
  const m = code.masked;
  const out: { start: number; end: number }[] = [];
  let delimiter = ';';
  let stmtStart = -1;
  const push = (end: number) => {
    if (stmtStart < 0) return;
    const sp = code.span(stmtStart, end);
    if (sp.end > sp.start) out.push({ start: sp.start, end: sp.end });
    stmtStart = -1;
  };
  const lineCount = code.lineCount;
  for (let ln = 0; ln < lineCount; ln++) {
    const ls = code.lineStart(ln);
    const le = code.lineEnd(ln);
    const codeLine = code.slice(ls, le).trim();
    const dm = /^DELIMITER\s+(\S+)/i.exec(codeLine);
    if (dm) {
      push(ls);
      delimiter = dm[1];
      continue;
    }
    if (/^GO(?:\s+\d+)?$/i.test(codeLine) || codeLine === '/') {
      push(ls);
      continue;
    }
    for (let i = ls; i < le; i++) {
      if (stmtStart < 0) {
        if (!isWs(m[i])) stmtStart = i;
        else continue;
      }
      if (m.startsWith(delimiter, i)) {
        push(i);
        i += delimiter.length - 1;
      }
    }
  }
  push(m.length);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migration vs definition, DOWN sections, engines
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isMigrationPath(path: string): boolean {
  const segs = pathSegments(path);
  if (segs.some((s) => /migrat/i.test(s) || s === 'deploy')) return true;
  const base = baseName(path).toLowerCase();
  if (/\.up\.sql$/.test(base) || base === 'up.sql') return true;
  if (/^v\d+(?:[._]\d+)*__/i.test(base)) return true; // Flyway versioned
  if (/^r__/i.test(base)) return true; // Flyway repeatable
  if (segs.includes('drizzle') && /^\d+_/.test(base)) return true;
  return false;
}

function isMigrationContent(text: string): boolean {
  const head = text.slice(0, 4000);
  return (
    /^\s*--\s*\+goose\s+(Up|Down)\b/im.test(head) ||
    /^\s*--\s*migrate:(up|down)\b/im.test(head) ||
    /^\s*--\s*\+migrate\s+(Up|Down)\b/im.test(head) ||
    /^\s*--\s*liquibase\s+formatted\s+sql/im.test(head) ||
    /^\s*--\s*changeset\b/im.test(head)
  );
}

/** Lines that belong to a migration DOWN / rollback section (0-based, true = skip). */
function downSkipLines(code: Code): boolean[] | null {
  const text = code.text;
  const skip = new Array<boolean>(code.lineCount).fill(false);
  let skipping = false;
  let any = false;
  for (let ln = 0; ln < code.lineCount; ln++) {
    const raw = text.slice(code.lineStart(ln), code.lineEnd(ln)).trim();
    if (/^--\s*\+goose\s+Down\b/i.test(raw) || /^--\s*migrate:down\b/i.test(raw) || /^--\s*\+migrate\s+Down\b/i.test(raw)) {
      skipping = true;
      any = true;
    } else if (/^--\s*\+goose\s+Up\b/i.test(raw) || /^--\s*migrate:up\b/i.test(raw) || /^--\s*\+migrate\s+Up\b/i.test(raw)) {
      skipping = false;
      any = true;
    }
    skip[ln] = skipping;
  }
  return any ? skip : null;
}

/** `masked` = comment/string-masked view; `raw` is only used for MySQL conditional comments (`/*!40101 … *\/`). */
function detectMysqlStyle(masked: string, raw: string): boolean {
  return masked.includes('`') || /\bENGINE\s*=/i.test(masked) || /\bAUTO_INCREMENT\b/i.test(masked) || /^\s*\/\*!\d{5}/m.test(raw);
}

interface EngineMatch {
  engine: EngineId;
  detail: string;
  offset: number;
}

function detectEngine(code: Code, ext: string, mysqlStyle: boolean): EngineMatch | null {
  if (ext === '.cql') return { engine: 'cassandra', detail: 'Cassandra CQL file', offset: 0 };
  // Sniff on the MASKED view so dialect keywords that merely occur inside string literals or
  // comments (an INSERT with `'serial number'`, a DEFAULT of `'uses AUTO_INCREMENT'`, a
  // "serial number" remark) can never be mistaken for real DDL and flip the engine.
  const s = code.masked;
  const find = (re: RegExp): number => {
    const m = re.exec(s);
    return m ? m.index : -1;
  };
  const checks: { re: RegExp; engine: EngineId; detail: string }[] = [
    { re: /\bENGINE\s*=\s*\w*MergeTree/i, engine: 'clickhouse', detail: 'ClickHouse (MergeTree engine)' },
    { re: /\bVARCHAR2\b|\bNVARCHAR2\b|\bNUMBER\s*\(/i, engine: 'oracle', detail: 'Oracle syntax (VARCHAR2 / NUMBER)' },
    { re: /\bIDENTITY\s*\(|\bNVARCHAR\b|\bsp_rename\b|\bNONCLUSTERED\b|\]\s*\.\s*\[/i, engine: 'sqlserver', detail: 'SQL Server syntax (IDENTITY / brackets)' },
    { re: /\bENGINE\s*=|\bAUTO_INCREMENT\b/i, engine: 'mysql', detail: 'MySQL syntax (ENGINE= / AUTO_INCREMENT)' },
    { re: /\bAUTOINCREMENT\b|\bWITHOUT\s+ROWID\b|\bPRAGMA\b/i, engine: 'sqlite', detail: 'SQLite syntax (AUTOINCREMENT)' },
    { re: /\b(?:big|small)?serial\b|CREATE\s+EXTENSION|LANGUAGE\s+plpgsql|::regclass|\bnextval\s*\(/i, engine: 'postgresql', detail: 'PostgreSQL syntax (SERIAL)' },
    { re: /ARRAY\s*<\s*STRUCT|\bINT64\b|\bSTRING\s*\(\s*MAX/i, engine: 'bigquery', detail: 'BigQuery syntax (STRUCT / INT64)' },
  ];
  for (const c of checks) {
    const idx = find(c.re);
    if (idx >= 0) return { engine: c.engine, detail: c.detail, offset: idx };
  }
  const tick = code.masked.indexOf('`'); // backtick-quoted identifiers, not backticks in comments/strings
  if (tick >= 0) return { engine: 'mysql', detail: 'MySQL syntax (backtick identifiers)', offset: tick };
  // MySQL / MariaDB executable comments (`/*!40101 … */`, `/*!50503 … */`) are a dialect-specific
  // marker that survives even dumps with no backticks / ENGINE= / AUTO_INCREMENT (e.g. the canonical
  // `employees` sample). `mysqlStyle` already confirmed one at the start of a line.
  if (mysqlStyle) {
    const cc = code.text.search(/\/\*!\d/);
    return { engine: 'mysql', detail: 'MySQL syntax (executable comment /*! … */)', offset: cc >= 0 ? cc : 0 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dispatch + public parser
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseStatement(ctx: Ctx, start: number, end: number): void {
  const head = ctx.s.slice(start, Math.min(end, start + 24)).toUpperCase();
  if (/^\s*CREATE\b/.test(head)) {
    const probe = ctx.s.slice(start, Math.min(end, start + 220));
    if (RE_CREATE_TABLE.test(probe)) parseCreateTable(ctx, start, end);
    else if (RE_CREATE_VIEW.test(probe)) parseCreateView(ctx, start, end);
    else if (RE_CREATE_INDEX.test(probe)) parseCreateIndex(ctx, start, end);
    else if (RE_CREATE_TYPE.test(probe)) parseCreateType(ctx, start, end);
    return;
  }
  if (/^\s*ALTER\b/.test(head)) {
    const probe = ctx.s.slice(start, Math.min(end, start + 60));
    if (RE_ALTER_TABLE.test(probe)) parseAlterTable(ctx, start, end);
    else if (RE_ALTER_TYPE.test(probe)) parseAlterType(ctx, start, end);
    return;
  }
  if (/^\s*DROP\b/.test(head)) {
    const probe = ctx.s.slice(start, Math.min(end, start + 60));
    if (RE_DROP_TABLE.test(probe)) parseDropTableView(ctx, start, end);
    else if (RE_DROP_TYPE.test(probe)) parseDropType(ctx, start, end);
    return;
  }
  if (/^\s*COMMENT\b/.test(head)) {
    if (RE_COMMENT_ON.test(ctx.s.slice(start, Math.min(end, start + 60)))) parseCommentOn(ctx, start, end);
    return;
  }
  if (/^\s*RENAME\b/.test(head)) {
    if (RE_RENAME_TABLE.test(ctx.s.slice(start, Math.min(end, start + 40)))) parseRenameTable(ctx, start, end);
    return;
  }
  if (/^\s*EXEC/.test(head)) {
    if (RE_SP_RENAME.test(ctx.s.slice(start, Math.min(end, start + 40)))) parseSpRename(ctx, start, end);
    return;
  }
}

function parse(file: { path: string; text: string }): ParseResult {
  const base = baseName(file.path).toLowerCase();
  if (/^u\d+(?:[._]\d+)*__/i.test(base)) return emptyResult('migration'); // Flyway undo file

  const migration = isMigrationPath(file.path) || isMigrationContent(file.text);
  const origin: 'definition' | 'migration' = migration ? 'migration' : 'definition';
  const result: ParseResult = { origin, entities: [], relations: [], enums: [], ops: [], engines: [], warnings: [] };

  let code: Code;
  let mysqlStyle = false;
  try {
    // Sniff the dialect outside comments and string contents (Prisma migrations, for example,
    // mention `Table` names in backticks inside /* … */ warning comments).
    code = new Code(file.text, 'sql');
    mysqlStyle = detectMysqlStyle(code.masked, file.text);
    if (mysqlStyle) code = new Code(file.text, 'sql', { backslashEscapes: true });
  } catch {
    return result;
  }

  const ext = extOf(file.path);
  const eng = detectEngine(code, ext, mysqlStyle);
  const engineHints: EngineHint[] = [];
  if (eng) engineHints.push({ engine: eng.engine, line: eng.offset >= 0 ? code.lineAt(eng.offset) : 0, detail: eng.detail });
  result.engines = engineHints;

  const ctx: Ctx = {
    file: file.path,
    code,
    s: code.stripped,
    m: code.masked,
    engine: eng?.engine,
    entities: result.entities,
    relations: result.relations,
    enums: result.enums,
    ops: result.ops!,
  };

  const skip = migration ? downSkipLines(code) : null;
  for (const stmt of splitStatements(code)) {
    if (skip && skip[code.lineAt(stmt.start)]) continue;
    try {
      parseStatement(ctx, stmt.start, stmt.end);
    } catch {
      // Defensive: never let one bad statement abort the whole file.
    }
  }

  if (!result.ops!.length) delete result.ops;
  if (!result.engines!.length) delete result.engines;
  if (!result.warnings!.length) delete result.warnings;
  return result;
}

function detect(file: { path: string; text: string }): boolean {
  const ext = extOf(file.path);
  if (ext !== '.sql' && ext !== '.ddl' && ext !== '.cql') return false;
  return /\b(?:CREATE|ALTER|DROP)\b/i.test(file.text);
}

export const sqlParser: SchemaParser = {
  kind: 'sql',
  extensions: ['.sql', '.ddl', '.cql'],
  detect,
  parse,
};
