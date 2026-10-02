/**
 * Kysely schema parser (`kind: 'kysely'`).
 *
 * Migration files (origin `migration`): the UP direction only. Parses
 * `db.schema.createTable('t').addColumn('id', 'serial', (c) => c.primaryKey())`, constraints
 * (`addPrimaryKeyConstraint`, `addUniqueConstraint`, `addForeignKeyConstraint`), `alterTable`
 * (addColumn / dropColumn / renameColumn / alterColumn / renameTo), `dropTable`, `createIndex`,
 * `createType('mood').asEnum([...])` and `withSchema`.
 *
 * Database interface types (origin `definition`): `interface Database { person: PersonTable }` +
 * `interface PersonTable { id: Generated<number>; … }` → one entity per Database key.
 */

import type { Column, ColumnPatch, IndexDef, ParseResult, RawEntity, SourceFile } from '../core/model';
import { column, type SchemaParser } from '../core/parser';
import { Code, stringValue } from '../core/text';
import { type Call, findInterfaces, type MemberDecl, members, normalizeTsType, propChain, stringArg } from './shared/jsorm';

const KIND = 'kysely' as const;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

function detect(file: SourceFile): boolean {
  const t = file.text;
  const kyselyImport = /\bfrom\s*['"]kysely['"]|require\(\s*['"]kysely['"]\)/.test(t);
  const migration = /\.\s*schema\s*\.\s*(?:createTable|alterTable|dropTable|createType|createIndex)/.test(t) && /\.addColumn\s*\(|\.execute\s*\(/.test(t);
  const dbInterface = /\bGenerated\s*</.test(t) && /\binterface\s+[A-Za-z_$]/.test(t);
  if (kyselyImport && (migration || dbInterface)) return true;
  if (migration && /\.addColumn\s*\(/.test(t)) return true;
  if (dbInterface && /\bKysely\s*</.test(t)) return true;
  return false;
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'js');
  const m = code.masked;
  const migration = /\.\s*schema\s*\./.test(m) && /(?:createTable|alterTable|dropTable|createType|createIndex)/.test(m) && /\.addColumn\s*\(|\.execute\s*\(/.test(m);
  return migration ? parseMigration(code, file) : parseDatabaseInterface(code, file);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────────────────────────────────────────────────────

function downRanges(code: Code): [number, number][] {
  const m = code.masked;
  const ranges: [number, number][] = [];
  const re = /\b(?:exports\s*\.\s*down|module\s*\.\s*exports\s*\.\s*down|(?:export\s+)?(?:async\s+)?function\s+down|(?:export\s+)?const\s+down|down)\s*[:=]?\s*/g;
  for (const match of m.matchAll(re)) {
    let i = match.index + match[0].length;
    const after = m.slice(i, i + 12);
    if (!/^(?:async\s+)?(?:function|\()/.test(after) && !/^[A-Za-z_$]\w*\s*=>/.test(after)) continue;
    while (i < m.length && /\s/.test(m[i])) i++;
    if (/^(?:async\s+)?function/.test(m.slice(i, i + 15))) i = m.indexOf('function', i) + 'function'.length;
    const paren = m.indexOf('(', i);
    if (paren >= 0) {
      const close = code.closing(paren);
      if (close > 0) i = close + 1;
    }
    // Skip an optional return-type annotation; the first `{` after the params is the body.
    const brace = m.indexOf('{', i);
    if (brace >= 0) {
      const close = code.closing(brace);
      if (close > brace) ranges.push([match.index, close]);
    }
  }
  return ranges;
}

const SCHEMA_RE = /\.\s*schema\b/g;

function parseMigration(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [], ops: [] };
  const m = code.masked;
  const down = downRanges(code);
  const seen = new Set<number>();

  for (const match of m.matchAll(SCHEMA_RE)) {
    if (down.some(([s, e]) => match.index >= s && match.index <= e)) continue;
    const schemaTok = match.index + match[0].length - 'schema'.length;
    const { calls } = propChain(code, schemaTok, m.length);
    if (!calls.length) continue;
    const first = calls[0];
    if (first.open >= 0 && seen.has(first.open)) continue;
    if (first.open >= 0) seen.add(first.open);
    dispatchChain(code, file, calls, result);
  }
  if (!result.ops!.length) delete result.ops;
  return result;
}

function dispatchChain(code: Code, file: SourceFile, calls: Call[], result: ParseResult): void {
  let schema: string | undefined;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const rest = calls.slice(i + 1);
    switch (call.name) {
      case 'withSchema':
        schema = stringArg(code, call.open, 0);
        break;
      case 'createTable':
      case 'createTableIfNotExists':
        buildCreateTable(code, file, call, rest, schema, result);
        return;
      case 'alterTable':
        buildAlterTable(code, file, call, rest, schema, result);
        return;
      case 'dropTable':
      case 'dropTableIfExists': {
        const name = stringArg(code, call.open, 0);
        if (name) (result.ops ??= []).push({ op: 'dropTable', table: { name, schema }, source: { file: file.path, line: call.line } });
        return;
      }
      case 'createType':
        buildCreateType(code, file, call, rest, schema, result);
        return;
      case 'createIndex':
        buildCreateIndex(code, file, calls.slice(i), schema, result);
        return;
      default:
        break;
    }
  }
}

function buildCreateTable(code: Code, file: SourceFile, call: Call, rest: Call[], schema: string | undefined, result: ParseResult): void {
  const name = stringArg(code, call.open, 0);
  if (!name) return;
  const columns: Column[] = [];
  const pkCols: string[] = [];
  const indexes: IndexDef[] = [];
  for (const c of rest) {
    if (c.name === 'addColumn') {
      const built = buildColumn(code, file, c, { name, schema }, result);
      if (built) columns.push(built);
    } else if (c.name === 'addPrimaryKeyConstraint') {
      pkCols.push(...nthArray(code, c, 1));
    } else if (c.name === 'addUniqueConstraint') {
      const cols = nthArray(code, c, 1);
      if (cols.length) indexes.push({ columns: cols, unique: true, source: { file: file.path, line: c.line } });
    } else if (c.name === 'addForeignKeyConstraint') {
      addForeignKeyConstraint(code, file, c, { name, schema }, result);
    }
  }
  for (const col of columns) {
    if (pkCols.some((p) => p.toLowerCase() === col.name.toLowerCase())) {
      col.primaryKey = true;
      col.nullable = false;
    }
  }
  const entity: RawEntity = { name, kind: 'table', columns, source: { file: file.path, line: call.line } };
  if (schema) entity.schema = schema;
  if (indexes.length) entity.indexes = indexes;
  result.entities.push(entity);
}

function buildAlterTable(code: Code, file: SourceFile, call: Call, rest: Call[], schema: string | undefined, result: ParseResult): void {
  const name = stringArg(code, call.open, 0);
  if (!name) return;
  const table = { name, schema };
  const added: Column[] = [];
  for (const c of rest) {
    switch (c.name) {
      case 'addColumn': {
        const built = buildColumn(code, file, c, table, result);
        if (built) added.push(built);
        break;
      }
      case 'dropColumn': {
        const col = stringArg(code, c.open, 0);
        if (col) (result.ops ??= []).push({ op: 'dropColumn', table, column: col, source: { file: file.path, line: c.line } });
        break;
      }
      case 'renameColumn': {
        const from = stringArg(code, c.open, 0);
        const to = stringArg(code, c.open, 1);
        if (from && to) (result.ops ??= []).push({ op: 'renameColumn', table, column: from, to, source: { file: file.path, line: c.line } });
        break;
      }
      case 'renameTo': {
        const to = stringArg(code, c.open, 0);
        if (to) (result.ops ??= []).push({ op: 'renameTable', table, to, source: { file: file.path, line: c.line } });
        break;
      }
      case 'alterColumn':
        buildAlterColumn(code, file, c, table, result);
        break;
      default:
        break;
    }
  }
  if (added.length) {
    const entity: RawEntity = { name, kind: 'table', columns: added, partial: true, source: { file: file.path, line: call.line } };
    if (schema) entity.schema = schema;
    result.entities.push(entity);
  }
}

function buildAlterColumn(code: Code, file: SourceFile, call: Call, table: { name: string; schema?: string }, result: ParseResult): void {
  const col = stringArg(code, call.open, 0);
  if (!col) return;
  const cb = code.args(call.open).positional[1];
  const set: ColumnPatch = {};
  if (cb) {
    for (const c of callbackChain(code, cb)) {
      if (c.name === 'setNotNull') set.nullable = false;
      else if (c.name === 'dropNotNull') set.nullable = true;
      else if (c.name === 'setDataType') {
        const t = typeArg(code, c, 0);
        if (t) set.type = t;
      } else if (c.name === 'setDefault') {
        const d = defaultArg(code, c);
        if (d !== undefined) set.default = d;
      }
    }
  }
  if (Object.keys(set).length) (result.ops ??= []).push({ op: 'alterColumn', table, column: col, set, source: { file: file.path, line: call.line } });
}

function buildColumn(code: Code, file: SourceFile, call: Call, table: { name: string; schema?: string }, result: ParseResult): Column | undefined {
  const name = stringArg(code, call.open, 0);
  if (!name) return undefined;
  const type = typeArg(code, call, 1) ?? '';
  const props: Partial<Column> = { source: { file: file.path, line: call.line }, nullable: true };
  const cb = code.args(call.open).positional[2];
  let refTable: string | undefined;
  let refCol: string | undefined;
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  if (cb) {
    for (const c of callbackChain(code, cb)) {
      switch (c.name) {
        case 'primaryKey':
          props.primaryKey = true;
          props.nullable = false;
          break;
        case 'notNull':
          props.nullable = false;
          break;
        case 'unique':
          props.unique = true;
          break;
        case 'autoIncrement':
        case 'generatedAlwaysAsIdentity':
        case 'generatedByDefaultAsIdentity':
          props.generated = true;
          break;
        case 'defaultTo': {
          const d = defaultArg(code, c);
          if (d !== undefined) props.default = d;
          break;
        }
        case 'references': {
          const r = stringArg(code, c.open, 0);
          if (r) {
            const dot = r.lastIndexOf('.');
            if (dot >= 0) {
              refTable = r.slice(0, dot);
              refCol = r.slice(dot + 1);
            }
          }
          break;
        }
        case 'onDelete':
          onDelete = stringArg(code, c.open, 0);
          break;
        case 'onUpdate':
          onUpdate = stringArg(code, c.open, 0);
          break;
        default:
          break;
      }
    }
  }
  const col = column(name, type, props);
  if (refTable) {
    result.relations.push({
      from: { name: table.name, schema: table.schema },
      fromColumns: [name],
      to: { name: refTable },
      toColumns: refCol ? [refCol] : [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
      optional: col.nullable,
      source: { file: file.path, line: call.line },
    });
  }
  return col;
}

function addForeignKeyConstraint(code: Code, file: SourceFile, call: Call, table: { name: string; schema?: string }, result: ParseResult): void {
  const args = code.args(call.open).positional;
  // (name, [cols], 'targetTable', [targetCols], cb?)
  const cols = args[1]?.text.startsWith('[') ? readStringArray(code, args[1].start) : [];
  const target = args[2] ? stringValue(args[2].text) : undefined;
  const targetCols = args[3]?.text.startsWith('[') ? readStringArray(code, args[3].start) : [];
  if (!cols.length || !target) return;
  const cb = args[4];
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  if (cb) {
    for (const c of callbackChain(code, cb)) {
      if (c.name === 'onDelete') onDelete = stringArg(code, c.open, 0);
      else if (c.name === 'onUpdate') onUpdate = stringArg(code, c.open, 0);
    }
  }
  result.relations.push({
    from: { name: table.name, schema: table.schema },
    fromColumns: cols,
    to: { name: target },
    toColumns: targetCols,
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    source: { file: file.path, line: call.line },
  });
}

function buildCreateType(code: Code, file: SourceFile, call: Call, rest: Call[], schema: string | undefined, result: ParseResult): void {
  const name = stringArg(code, call.open, 0);
  if (!name) return;
  const asEnum = rest.find((c) => c.name === 'asEnum');
  if (!asEnum) return;
  const arr = code.args(asEnum.open).positional.find((p) => p.text.startsWith('['));
  if (!arr) return;
  const values = readStringArray(code, arr.start);
  if (values.length) result.enums.push({ name, ...(schema ? { schema } : {}), values, source: { file: file.path, line: call.line } });
}

function buildCreateIndex(code: Code, file: SourceFile, calls: Call[], schema: string | undefined, result: ParseResult): void {
  const head = calls[0];
  const name = stringArg(code, head.open, 0);
  let table: string | undefined;
  const cols: string[] = [];
  let unique = false;
  for (const c of calls.slice(1)) {
    if (c.name === 'on') table = stringArg(code, c.open, 0);
    else if (c.name === 'column') {
      const col = stringArg(code, c.open, 0);
      if (col) cols.push(col);
    } else if (c.name === 'columns') {
      const arr = code.args(c.open).positional.find((p) => p.text.startsWith('['));
      if (arr) cols.push(...readStringArray(code, arr.start));
    } else if (c.name === 'unique') unique = true;
  }
  if (!table || !cols.length) return;
  const entity: RawEntity = {
    name: table,
    kind: 'table',
    columns: [],
    partial: true,
    indexes: [{ ...(name ? { name } : {}), columns: cols, unique, source: { file: file.path, line: head.line } }],
    source: { file: file.path, line: head.line },
  };
  if (schema) entity.schema = schema;
  result.entities.push(entity);
}

/** Modifier chain inside an `(col) => col.a().b()` callback argument span. */
function callbackChain(code: Code, cb: { start: number; end: number }): Call[] {
  const m = code.masked;
  const arrow = m.indexOf('=>', cb.start);
  let start = arrow >= 0 && arrow < cb.end ? arrow + 2 : cb.start;
  while (start < cb.end && /\s/.test(m[start])) start++;
  return propChain(code, start, cb.end).calls;
}

function typeArg(code: Code, call: Call, idx: number): string | undefined {
  const sp = code.args(call.open).positional[idx];
  if (!sp) return undefined;
  const s = stringValue(sp.text);
  if (s !== undefined) return s;
  const sql = /`([^`]*)`/.exec(sp.text);
  return sql ? sql[1].trim() : undefined;
}

function defaultArg(code: Code, call: Call): string | undefined {
  const sp = code.args(call.open).positional[0];
  if (!sp) return undefined;
  const sql = /`([^`]*)`/.exec(sp.text);
  if (sql && /\bsql\s*`/.test(sp.text)) return sql[1].trim();
  return sp.text;
}

function nthArray(code: Code, call: Call, idx: number): string[] {
  const sp = code.args(call.open).positional[idx];
  return sp?.text.startsWith('[') ? readStringArray(code, sp.start) : [];
}

function readStringArray(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const it of code.items(open)) {
    const v = stringValue(it.text);
    if (v !== undefined) out.push(v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Database interface types
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseDatabaseInterface(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { entities: [], relations: [], enums: [] };
  const interfaces = findInterfaces(code);
  if (!interfaces.length) return result;
  const byName = new Map(interfaces.map((i) => [i.name, i]));

  const kyselyType = /\bKysely\s*<\s*([A-Za-z_$][\w$]*)\s*>/.exec(code.masked);
  const dbName = kyselyType?.[1];
  const dbIface = (dbName && byName.get(dbName)) || interfaces.find((i) => /^(Database|DB)$/i.test(i.name));
  if (!dbIface) return result;

  for (const entry of members(code, dbIface.bodyOpen, dbIface.bodyClose, { asiNewline: true, angle: true })) {
    const rowType = cleanTypeName(entry.type);
    const row = rowType ? byName.get(rowType) : undefined;
    if (!row) continue;
    const parts = entry.name.split('.');
    const name = parts.length >= 2 ? parts[parts.length - 1] : entry.name;
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const columns: Column[] = [];
    for (const field of members(code, row.bodyOpen, row.bodyClose, { asiNewline: true, angle: true })) {
      columns.push(rowColumn(file, field));
    }
    const entity: RawEntity = {
      name,
      kind: 'table',
      modelName: row.name,
      nameCertainty: 2,
      columns,
      source: { file: file.path, line: entry.line },
    };
    if (schema) entity.schema = schema;
    result.entities.push(entity);
  }
  return result;
}

function cleanTypeName(raw: string): string | undefined {
  const t = raw.trim().replace(/\[\]$/, '').replace(/<.*>$/, '');
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : undefined;
}

function rowColumn(file: SourceFile, field: MemberDecl): Column {
  let t = field.type.trim();
  let generated = false;
  const gen = /^Generated(?:Always|ByDefault)?\s*<([\s\S]*)>$/.exec(t);
  if (gen) {
    generated = true;
    t = gen[1].trim();
  }
  const col = /^ColumnType\s*<([\s\S]*)>$/.exec(t);
  if (col) t = splitAngleTop(col[1])[0]?.trim() ?? '';
  const parts = splitAngleTop(t, '|').map((p) => p.trim());
  const nullable = field.optional || parts.includes('null') || parts.includes('undefined');
  const kept = parts.filter((p) => p !== 'null' && p !== 'undefined');
  const type = kept.length === 1 ? normalizeTsType(kept[0]).type : '';
  const props: Partial<Column> = { nullable, source: { file: file.path, line: field.line } };
  if (generated) {
    props.generated = true;
  }
  return column(field.name, type, props);
}

/** Splits a type string on `sep` at angle/brace/paren depth 0. */
function splitAngleTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === sep) {
      out.push(s.slice(seg, i));
      seg = i + 1;
    }
  }
  out.push(s.slice(seg));
  return out.map((x) => x.trim()).filter(Boolean);
}

export const kyselyParser: SchemaParser = { kind: KIND, extensions: EXTENSIONS, detect, parse };
