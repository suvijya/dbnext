/**
 * DBML parser (https://dbml.dbdiagram.io). Reads `.dbml` schema definition files.
 *
 * Handles: `Table [schema.]name [as alias] [settings] { … }` with column settings
 * (`pk`/`primary key`, `increment`, `not null`, `null`, `unique`, `default:`, `note:`, `ref:`),
 * `indexes { (a, b) [unique, name: '…'] ; col [pk] }`, table `Note:`, top-level and block `Ref`s
 * (including composite `a.(x,y) > b.(x,y)` and all four operators `>`, `<`, `-`, `<>`), table
 * aliases, `Enum [schema.]name { … }` and `Project { database_type: '…' }`. Pure, never throws.
 */

import type { EngineId, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { Code, splitQualified, stringValue, unquoteIdent } from '../core/text';
import { collapseWs, normalizeAction } from './shared/schemas';

interface Endpoint {
  schema?: string;
  table: string;
  columns: string[];
}

interface PendingRel {
  from: Endpoint;
  to: Endpoint;
  op: '>' | '<' | '-' | '<>';
  name?: string;
  onDelete?: string;
  onUpdate?: string;
  line: number;
}

const WORD = /[A-Za-z0-9_]/;
const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c);
const isWordStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

function detect(file: SourceFile): boolean {
  const t = file.text;
  return /\b(Table|Enum|Ref|Project|TableGroup)\b/.test(t);
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'dbml');
  const m = code.masked;
  const n = m.length;
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const aliases = new Map<string, { name: string; schema?: string }>();
  const realNames = new Set<string>();
  const pending: PendingRel[] = [];

  const skipSpaces = (p: number): number => {
    while (p < n && isSpace(m[p])) p++;
    return p;
  };

  // ── header helpers ──
  function headerName(start: number, end: number): { name: string; schema?: string; alias?: string } {
    const headerMasked = m.slice(start, end);
    const asMatch = /\bas\b/i.exec(headerMasked);
    let namePart: string;
    let alias: string | undefined;
    if (asMatch) {
      namePart = code.stripped.slice(start, start + asMatch.index);
      alias = unquoteIdent(code.stripped.slice(start + asMatch.index + 2, end).trim());
    } else {
      namePart = code.stripped.slice(start, end);
    }
    const parts = splitQualified(namePart.trim());
    const name = parts.length ? parts[parts.length - 1] : namePart.trim();
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    return { name, schema, alias };
  }

  /** Offset of the first `[` of trailing settings between `start` and `open` (depth 0), or -1. */
  function headerSettings(start: number, open: number): number {
    let depth = 0;
    for (let i = start; i < open; i++) {
      const c = m[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '[' && depth === 0) return i;
    }
    return -1;
  }

  // ── columns & indexes ──
  function parseColumn(start: number, limit: number, entity: RawEntity, tableName: string, tableSchema?: string): number {
    const lineEnd = Math.min(limit, code.lineEnd(code.lineAt(start)));
    // Locate `[settings]` on this line at paren depth 0.
    let settingsOpen = -1;
    let depth = 0;
    for (let i = start; i < lineEnd; i++) {
      const c = m[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '[' && depth === 0) {
        settingsOpen = i;
        break;
      }
    }
    let stmtEnd = lineEnd;
    let close = -1;
    if (settingsOpen >= 0) {
      close = code.closing(settingsOpen);
      if (close < 0) close = lineEnd;
      stmtEnd = Math.max(lineEnd, close + 1);
    }
    const decl = code.stripped.slice(start, settingsOpen >= 0 ? settingsOpen : stmtEnd).trim();
    const nm = /^("(?:[^"]|"")*"|`[^`]*`|'[^']*'|[^\s]+)\s*([\s\S]*)$/.exec(decl);
    if (!nm) return Math.max(stmtEnd, start + 1);
    const colName = unquoteIdent(nm[1]);
    const type = collapseWs(nm[2]);
    const col = column(colName, type, { nullable: true, source: sourceRef(file, code.lineAt(start)) });

    if (settingsOpen >= 0 && close > settingsOpen) {
      for (const s of code.split(settingsOpen + 1, close, ',')) {
        applyColumnSetting(s.text, col, entity, tableName, tableSchema, colName, code.lineAt(start));
      }
    }
    entity.columns.push(col);
    return Math.max(stmtEnd, start + 1);
  }

  function applyColumnSetting(
    raw: string,
    col: ReturnType<typeof column>,
    _entity: RawEntity,
    tableName: string,
    tableSchema: string | undefined,
    colName: string,
    line: number,
  ): void {
    const t = raw.trim();
    const lower = t.toLowerCase();
    if (lower === 'pk' || lower === 'primary key') {
      col.primaryKey = true;
      col.nullable = false;
    } else if (lower === 'increment') {
      col.generated = true;
    } else if (lower === 'not null') {
      col.nullable = false;
    } else if (lower === 'null') {
      col.nullable = true;
    } else if (lower === 'unique') {
      col.unique = true;
    } else {
      const kv = /^([A-Za-z_]+)\s*:\s*([\s\S]+)$/.exec(t);
      if (!kv) return;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'default') {
        col.default = value.replace(/^`|`$/g, '');
      } else if (key === 'note') {
        col.comment = stringValue(value) ?? value.replace(/^['"`]|['"`]$/g, '');
      } else if (key === 'ref') {
        const ep = parseRefValue(value, { schema: tableSchema, table: tableName, columns: [colName] });
        if (ep) pending.push({ ...ep, line });
      }
    }
  }

  /** A column-level `ref: > table.col` where the left endpoint is the current column. */
  function parseRefValue(value: string, left: Endpoint): Omit<PendingRel, 'line'> | undefined {
    const om = /^(<>|[<>-])\s*([\s\S]+)$/.exec(value.trim());
    if (!om) return undefined;
    const op = om[1] as PendingRel['op'];
    const right = parseEndpoint(om[2]);
    if (!right) return undefined;
    return { from: left, to: right, op };
  }

  function parseIndexes(open: number, close: number, entity: RawEntity): void {
    let p = open + 1;
    while (p < close) {
      p = skipSpaces(p);
      if (p >= close) break;
      const lineEnd = Math.min(close, code.lineEnd(code.lineAt(p)));
      // settings `[...]`
      let settingsOpen = -1;
      let depth = 0;
      for (let i = p; i < lineEnd; i++) {
        const c = m[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === '[' && depth === 0) {
          settingsOpen = i;
          break;
        }
      }
      const specEnd = settingsOpen >= 0 ? settingsOpen : lineEnd;
      const spec = code.stripped.slice(p, specEnd).trim();
      if (spec) {
        let columns: string[];
        if (spec.startsWith('(')) {
          const inner = spec.slice(1, spec.lastIndexOf(')') >= 0 ? spec.lastIndexOf(')') : spec.length);
          columns = inner.split(',').map((x) => unquoteIdent(x.trim())).filter(Boolean);
        } else {
          columns = [unquoteIdent(spec)];
        }
        let unique = false;
        let name: string | undefined;
        let pk = false;
        if (settingsOpen >= 0) {
          for (const s of code.items(settingsOpen)) {
            const st = s.text.trim().toLowerCase();
            if (st === 'unique') unique = true;
            else if (st === 'pk') pk = true;
            else {
              const kv = /^name\s*:\s*([\s\S]+)$/i.exec(s.text.trim());
              if (kv) name = stringValue(kv[1].trim()) ?? kv[1].trim().replace(/^['"`]|['"`]$/g, '');
            }
          }
        }
        if (pk) {
          for (const c of columns) {
            const existing = entity.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
            if (existing) {
              existing.primaryKey = true;
              existing.nullable = false;
            }
          }
        }
        if (columns.length) {
          entity.indexes ??= [];
          entity.indexes.push({ columns, unique: unique || pk, ...(name ? { name } : {}), source: sourceRef(file, code.lineAt(p)) });
        }
      }
      const close2 = settingsOpen >= 0 ? code.closing(settingsOpen) : -1;
      p = Math.max(lineEnd, close2 + 1, p + 1);
    }
  }

  function parseTableBody(open: number, close: number, entity: RawEntity, tableName: string, tableSchema?: string): void {
    let p = open + 1;
    while (p < close) {
      p = skipSpaces(p);
      if (p >= close) break;
      if (isWordStart(m[p]) && !isWord(m[p - 1])) {
        let q = p;
        while (q < close && isWord(m[q])) q++;
        const w = m.slice(p, q).toLowerCase();
        const after = skipSpaces(q);
        if (w === 'indexes' && m[after] === '{') {
          const ic = code.closing(after);
          const end = ic < 0 ? close : ic;
          parseIndexes(after, end, entity);
          p = end + 1;
          continue;
        }
        if (w === 'note' && m[after] === ':') {
          const vStart = skipSpaces(after + 1);
          const vEnd = valueEnd(vStart, close);
          const val = code.stripped.slice(vStart, vEnd).trim();
          entity.comment = stringValue(val) ?? val.replace(/^['"`]|['"`]$/g, '');
          p = vEnd;
          continue;
        }
        p = parseColumn(p, close, entity, tableName, tableSchema);
        continue;
      }
      p++;
    }
  }

  /** End of a value: end of its line, extended to cover a string literal that starts it. */
  function valueEnd(start: number, limit: number): number {
    const lineEnd = Math.min(limit, code.lineEnd(code.lineAt(start)));
    if (code.inString(start)) {
      // Walk to the end of the string region (quotes kept in masked).
      let i = start;
      while (i < limit && code.inString(i)) i++;
      return Math.min(limit, Math.max(lineEnd, i));
    }
    return lineEnd;
  }

  // ── endpoints & refs ──
  function parseEndpoint(text: string): Endpoint | undefined {
    const s = text.trim();
    if (!s) return undefined;
    const paren = s.indexOf('(');
    if (paren >= 0) {
      const head = s.slice(0, paren).replace(/\.\s*$/, '').trim();
      const tableParts = splitQualified(head);
      const rp = s.lastIndexOf(')');
      const inner = s.slice(paren + 1, rp >= 0 ? rp : s.length);
      const columns = inner.split(',').map((x) => unquoteIdent(x.trim())).filter(Boolean);
      return makeEndpoint(tableParts, columns);
    }
    const parts = splitQualified(s);
    if (!parts.length) return undefined;
    const columns = [parts[parts.length - 1]];
    return makeEndpoint(parts.slice(0, -1), columns);
  }

  function makeEndpoint(tableParts: string[], columns: string[]): Endpoint | undefined {
    if (!tableParts.length) return undefined;
    const table = tableParts[tableParts.length - 1];
    const schema = tableParts.length >= 2 ? tableParts[tableParts.length - 2] : undefined;
    return { table, schema, columns };
  }

  /** Parses one `endpoint OP endpoint [settings]` expression (top-level or inside a `Ref { }` block). */
  function parseRefExpr(start: number, end: number, name: string | undefined): void {
    // settings
    let settingsOpen = -1;
    let depth = 0;
    for (let i = start; i < end; i++) {
      const c = m[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '[' && depth === 0) {
        settingsOpen = i;
        break;
      }
    }
    const epEnd = settingsOpen >= 0 ? settingsOpen : end;
    // operator
    let op: PendingRel['op'] | undefined;
    let opStart = -1;
    let opEnd = -1;
    depth = 0;
    for (let i = start; i < epEnd; i++) {
      const c = m[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (c === '<' && m[i + 1] === '>') {
          op = '<>';
          opStart = i;
          opEnd = i + 2;
          break;
        }
        if (c === '>' || c === '<' || c === '-') {
          op = c;
          opStart = i;
          opEnd = i + 1;
          break;
        }
      }
    }
    if (!op) return;
    const left = parseEndpoint(code.stripped.slice(start, opStart));
    const right = parseEndpoint(code.stripped.slice(opEnd, epEnd));
    if (!left || !right) return;
    let onDelete: string | undefined;
    let onUpdate: string | undefined;
    if (settingsOpen >= 0 && code.closing(settingsOpen) > settingsOpen) {
      for (const s of code.items(settingsOpen)) {
        const kv = /^(delete|update)\s*:\s*([\s\S]+)$/i.exec(s.text.trim());
        if (!kv) continue;
        const act = normalizeAction(kv[2]);
        if (/^delete$/i.test(kv[1])) onDelete = act;
        else onUpdate = act;
      }
    }
    pending.push({ from: left, to: right, op, name, onDelete, onUpdate, line: code.lineAt(start) });
  }

  function parseRef(afterKw: number): number {
    let p = skipSpaces(afterKw);
    let name: string | undefined;
    // optional ref name before ':' or '{'
    if (isWordStart(m[p])) {
      let q = p;
      while (isWord(m[q])) q++;
      const r = skipSpaces(q);
      if (m[r] === ':' || m[r] === '{') {
        name = code.stripped.slice(p, q);
        p = r;
      }
    }
    if (m[p] === ':') p = skipSpaces(p + 1);
    if (m[p] === '{') {
      const close = code.closing(p);
      const end = close < 0 ? n : close;
      // each non-empty line in the block is a ref expression
      let line = code.lineAt(p + 1);
      const lastLine = code.lineAt(end);
      for (; line <= lastLine; line++) {
        const ls = Math.max(p + 1, code.lineStart(line));
        const le = Math.min(end, code.lineEnd(line));
        if (code.stripped.slice(ls, le).trim()) parseRefExpr(ls, le, name);
      }
      return end + 1;
    }
    // inline ref until end of line
    const le = code.lineEnd(code.lineAt(p));
    parseRefExpr(p, le, name);
    return le;
  }

  // ── enums & project ──
  function parseEnum(afterKw: number, open: number, close: number): void {
    const { name, schema } = headerName(afterKw, open);
    const values: string[] = [];
    let line = code.lineAt(open + 1);
    const lastLine = code.lineAt(close);
    for (; line <= lastLine; line++) {
      const ls = Math.max(open + 1, code.lineStart(line));
      const le = Math.min(close, code.lineEnd(line));
      const raw = code.stripped.slice(ls, le);
      // value is the first token (before optional `[note: …]`)
      const bracket = raw.indexOf('[');
      const token = (bracket >= 0 ? raw.slice(0, bracket) : raw).trim();
      if (token) values.push(unquoteIdent(token));
    }
    if (name && values.length) {
      result.enums.push({ name, ...(schema ? { schema } : {}), values, source: sourceRef(file, code.lineAt(afterKw)) });
    }
  }

  function parseProject(open: number, close: number, line: number): void {
    const body = code.stripped.slice(open + 1, close);
    const m2 = /database_type\s*:\s*([\s\S]+?)(?:\n|$)/i.exec(body);
    if (!m2) return;
    const engine = databaseTypeEngine(stringValue(m2[1].trim()) ?? m2[1].trim());
    if (engine) {
      result.engines ??= [];
      result.engines.push({ engine, line, detail: `DBML database_type "${(stringValue(m2[1].trim()) ?? m2[1].trim()).trim()}"` });
    }
  }

  // ── main scan ──
  let i = 0;
  while (i < n) {
    const ch = m[i];
    if (!isWordStart(ch) || isWord(m[i - 1])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWord(m[j])) j++;
    const word = m.slice(i, j);
    const lw = word.toLowerCase();
    if (lw === 'ref') {
      i = parseRef(j);
      continue;
    }
    if (lw === 'table' || lw === 'tablegroup' || lw === 'enum' || lw === 'project') {
      const open = m.indexOf('{', j);
      if (open < 0) {
        i = j;
        continue;
      }
      const close = code.closing(open);
      const end = close < 0 ? n : close;
      if (lw === 'tablegroup') {
        i = end + 1; // grouping only – ignored
        continue;
      }
      if (lw === 'project') {
        parseProject(open, end, code.lineAt(i));
        i = end + 1;
        continue;
      }
      if (lw === 'enum') {
        parseEnum(j, open, end);
        i = end + 1;
        continue;
      }
      // Table
      const settings = headerSettings(j, open);
      const nameEnd = settings >= 0 ? settings : open;
      const { name, schema, alias } = headerName(j, nameEnd);
      const entity: RawEntity = {
        name,
        kind: 'table',
        ...(schema ? { schema } : {}),
        nameCertainty: 2,
        columns: [],
        source: sourceRef(file, code.lineAt(i)),
      };
      if (settings >= 0) {
        const sc = code.closing(settings);
        if (sc > settings) {
          for (const s of code.items(settings)) {
            const kv = /^note\s*:\s*([\s\S]+)$/i.exec(s.text.trim());
            if (kv) entity.comment = stringValue(kv[1].trim()) ?? kv[1].trim().replace(/^['"`]|['"`]$/g, '');
          }
        }
      }
      parseTableBody(open, end, entity, name, schema);
      realNames.add(name.toLowerCase());
      if (alias) aliases.set(alias.toLowerCase(), { name, schema });
      result.entities.push(entity);
      i = end + 1;
      continue;
    }
    i = j;
  }

  // Resolve table aliases used in refs, then build the raw relations.
  const resolve = (ep: Endpoint): { name: string; schema?: string } => {
    const key = ep.table.toLowerCase();
    if (!realNames.has(key) && aliases.has(key)) {
      const a = aliases.get(key)!;
      return { name: a.name, ...(a.schema ? { schema: a.schema } : {}) };
    }
    return { name: ep.table, ...(ep.schema ? { schema: ep.schema } : {}) };
  };

  for (const r of pending) {
    result.relations.push(buildRelation(r, resolve, file.path));
  }
  return result;
}

function buildRelation(
  r: PendingRel,
  resolve: (ep: Endpoint) => { name: string; schema?: string },
  filePath: string,
): RawRelation {
  const leftRef = resolve(r.from);
  const rightRef = resolve(r.to);
  const base = {
    kind: 'foreign-key' as const,
    ...(r.name ? { name: r.name } : {}),
    ...(r.onDelete ? { onDelete: r.onDelete } : {}),
    ...(r.onUpdate ? { onUpdate: r.onUpdate } : {}),
    source: { file: filePath, line: r.line },
  };
  if (r.op === '>') {
    return { from: leftRef, fromColumns: r.from.columns, to: rightRef, toColumns: r.to.columns, cardinality: 'many-to-one', ...base };
  }
  if (r.op === '<') {
    return { from: rightRef, fromColumns: r.to.columns, to: leftRef, toColumns: r.from.columns, cardinality: 'many-to-one', ...base };
  }
  if (r.op === '-') {
    return { from: leftRef, fromColumns: r.from.columns, to: rightRef, toColumns: r.to.columns, cardinality: 'one-to-one', ...base };
  }
  return { from: leftRef, fromColumns: r.from.columns, to: rightRef, toColumns: r.to.columns, cardinality: 'many-to-many', ...base };
}

function databaseTypeEngine(value: string): EngineId | undefined {
  const v = value.toLowerCase();
  if (v.includes('postgres')) return 'postgresql';
  if (v.includes('mariadb')) return 'mariadb';
  if (v.includes('mysql')) return 'mysql';
  if (v.includes('sqlite')) return 'sqlite';
  if (v.includes('sql server') || v.includes('sqlserver') || v.includes('mssql')) return 'sqlserver';
  if (v.includes('oracle')) return 'oracle';
  return undefined;
}

export const dbmlParser: SchemaParser = {
  kind: 'dbml',
  extensions: ['.dbml'],
  detect,
  parse,
};
