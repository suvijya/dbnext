/**
 * Knex schema parser (`kind: 'knex'`).
 *
 * Migration files (origin `migration`): the UP direction only. Parses
 * `knex.schema[.withSchema('s')].createTable / alterTable / table / dropTable / renameTable`
 * and the builder callback (`table.increments`, `table.string('x', 255).notNullable().unique()`,
 * `table.integer('user_id').references('id').inTable('users').onDelete('CASCADE')`, `table.timestamps`,
 * `table.enu`, `table.specificType`, `table.primary/unique/index`, drops / renames / `.alter()`).
 *
 * Objection models (origin `definition`): `static tableName` + `relationMappings`.
 */

import type { Column, IndexDef, ParseResult, RawEntity, RawEnum, RawRelation, SchemaOp, SourceFile } from '../core/model';
import { column, type SchemaParser } from '../core/parser';
import { Code, numberValue, stringValue } from '../core/text';
import { shortName } from '../core/naming';
import { type Call, callChain, findClasses, propChain, stringArg } from './shared/jsorm';

const KIND = 'knex' as const;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/\bfrom\s*['"]kysely['"]|require\(\s*['"]kysely['"]\)/.test(t)) return false;
  const callbackCreate = /\b(?:createTable|createTableIfNotExists|alterTable|table)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?(?:function|\()/.test(t);
  const builderMethods = /\b[A-Za-z_$][\w$]*\s*\.\s*(?:increments|bigIncrements|timestamps|specificType)\s*\(/.test(t);
  if (callbackCreate || builderMethods) return true;
  if (/relationMappings/.test(t) || (/extends\s+Model\b/.test(t) && /static\s+(?:get\s+)?tableName/.test(t))) return true;
  const schemaOp = /\.\s*schema\s*\./.test(t) && /(?:createTable|alterTable|dropTable|renameTable)/.test(t);
  const knexImport = /\bfrom\s*['"]knex['"]|require\(\s*['"]knex['"]\)|\bKnex\b/.test(t);
  if (schemaOp && knexImport && !/\.addColumn\s*\(/.test(t)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Down-direction exclusion
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Byte ranges of `down` functions, whose schema statements must be ignored. */
function downRanges(code: Code): [number, number][] {
  const m = code.masked;
  const ranges: [number, number][] = [];
  const re = /\b(?:exports\s*\.\s*down|module\s*\.\s*exports\s*\.\s*down|(?:export\s+)?(?:async\s+)?function\s+down|(?:export\s+)?const\s+down|down)\s*[:=]?\s*/g;
  for (const match of m.matchAll(re)) {
    const after = m.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (!/^(?:async\s+)?(?:function|\()/.test(after) && !/^[A-Za-z_$]\w*\s*=>/.test(after)) continue;
    const brace = findBodyBrace(code, match.index + match[0].length);
    if (brace < 0) continue;
    const close = code.closing(brace);
    if (close > brace) ranges.push([match.index, close]);
  }
  return ranges;
}

/** Offset of the function body `{` after a header position, skipping the parameter list. */
function findBodyBrace(code: Code, from: number): number {
  const m = code.masked;
  let i = from;
  while (i < m.length && /\s/.test(m[i])) i++;
  if (/^(?:async\s+)?function/.test(m.slice(i, i + 15))) i = m.indexOf('function', i) + 'function'.length;
  const paren = m.indexOf('(', i);
  const arrow = m.indexOf('=>', i);
  if (paren >= 0 && (arrow < 0 || paren < arrow)) {
    const close = code.closing(paren);
    if (close < 0) return -1;
    i = close + 1;
  }
  const a = m.indexOf('=>', i);
  let j = a >= 0 && a < i + 4 ? a + 2 : i;
  while (j < m.length && /\s/.test(m[j])) j++;
  return m[j] === '{' ? j : -1;
}

function inRanges(pos: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([s, e]) => pos >= s && pos <= e);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migration parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SCHEMA_RE = /\.\s*schema\b/g;

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'js');
  const hasSchema = /\.\s*schema\s*\./.test(code.masked) && /(?:createTable|alterTable|dropTable|renameTable|table)\s*\(/.test(code.masked);
  return hasSchema ? parseMigration(code, file) : parseObjection(code, file);
}

function parseMigration(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [], ops: [] };
  const m = code.masked;
  const down = downRanges(code);
  const seen = new Set<number>();

  for (const match of m.matchAll(SCHEMA_RE)) {
    const schemaTok = match.index + match[0].length - 'schema'.length;
    if (inRanges(match.index, down)) continue;
    const { calls } = propChain(code, schemaTok, m.length);
    let currentSchema: string | undefined;
    for (const call of calls) {
      if (call.open >= 0 && seen.has(call.open)) continue;
      if (call.open >= 0) seen.add(call.open);
      if (call.name === 'withSchema') {
        currentSchema = stringArg(code, call.open, 0);
      } else if (call.name === 'createTable' || call.name === 'createTableIfNotExists') {
        buildTable(code, file, call, currentSchema, result, 'create');
      } else if (call.name === 'alterTable' || call.name === 'table') {
        buildTable(code, file, call, currentSchema, result, 'alter');
      } else if (call.name === 'dropTable' || call.name === 'dropTableIfExists') {
        const name = stringArg(code, call.open, 0);
        if (name) result.ops!.push({ op: 'dropTable', table: { name, schema: currentSchema }, source: { file: file.path, line: call.line } });
      } else if (call.name === 'renameTable') {
        const from = stringArg(code, call.open, 0);
        const to = stringArg(code, call.open, 1);
        if (from && to) result.ops!.push({ op: 'renameTable', table: { name: from, schema: currentSchema }, to, source: { file: file.path, line: call.line } });
      }
    }
  }
  if (!result.ops!.length) delete result.ops;
  return result;
}

/** Param name and `;`-split statements of a `createTable`/`alterTable` builder callback. */
function builderStatements(code: Code, call: Call): { param: string; statements: { start: number; end: number }[] } | undefined {
  const m = code.masked;
  const cb = code.args(call.open).positional[1];
  if (!cb) return undefined;
  const paren = /\(\s*([A-Za-z_$][\w$]*)/.exec(m.slice(cb.start, cb.end));
  const arrow1 = /^\s*([A-Za-z_$][\w$]*)\s*=>/.exec(m.slice(cb.start, cb.end));
  const param = paren ? paren[1] : arrow1 ? arrow1[1] : undefined;
  if (!param) return undefined;
  const arrowIdx = m.indexOf('=>', cb.start);
  let bodyStart: number;
  if (arrowIdx >= 0 && arrowIdx < cb.end) bodyStart = arrowIdx + 2;
  else {
    const p = m.indexOf('(', cb.start);
    const c = p >= 0 ? code.closing(p) : -1;
    bodyStart = c >= 0 ? c + 1 : cb.start;
  }
  while (bodyStart < cb.end && /\s/.test(m[bodyStart])) bodyStart++;
  if (m[bodyStart] === '{') {
    const inner = code.inner(bodyStart);
    if (!inner) return { param, statements: [] };
    return { param, statements: code.split(inner.start, inner.end, ';').map((s) => ({ start: s.start, end: s.end })) };
  }
  return { param, statements: [{ start: bodyStart, end: cb.end }] };
}

function buildTable(code: Code, file: SourceFile, call: Call, schema: string | undefined, result: ParseResult, mode: 'create' | 'alter'): void {
  const name = stringArg(code, call.open, 0);
  if (!name) return;
  const parsed = builderStatements(code, call);
  const columns: Column[] = [];
  const indexes: IndexDef[] = [];
  const ops: SchemaOp[] = [];
  const pkCols: string[] = [];
  const line = call.line;

  if (parsed) {
    const sink: Sink = { columns, indexes, ops, pkCols, relations: result.relations, enums: result.enums };
    for (const stmt of parsed.statements) {
      const { receiver, calls } = propChain(code, stmt.start, stmt.end);
      if (receiver !== parsed.param || !calls.length) continue;
      classifyBuilder(code, file, { name, schema }, calls, sink, mode);
    }
  }
  for (const c of columns) {
    if (pkCols.some((p) => p.toLowerCase() === c.name.toLowerCase())) {
      c.primaryKey = true;
      c.nullable = false;
    }
  }

  const entity: RawEntity = { name, kind: 'table', columns, source: { file: file.path, line } };
  if (schema) entity.schema = schema;
  if (indexes.length) entity.indexes = indexes;
  if (mode === 'alter') entity.partial = true;
  if (mode === 'create' || columns.length) result.entities.push(entity);
  (result.ops ??= []).push(...ops);
}

const TYPE_METHODS: Record<string, string> = {
  increments: 'integer',
  bigIncrements: 'bigint',
  integer: 'integer',
  bigInteger: 'bigint',
  tinyint: 'tinyint',
  smallint: 'smallint',
  mediumint: 'mediumint',
  string: 'varchar',
  text: 'text',
  mediumtext: 'mediumtext',
  longtext: 'longtext',
  boolean: 'boolean',
  date: 'date',
  dateTime: 'datetime',
  datetime: 'datetime',
  timestamp: 'timestamp',
  time: 'time',
  float: 'float',
  double: 'double',
  decimal: 'decimal',
  bigint: 'bigint',
  binary: 'binary',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  enu: 'enum',
  enum: 'enum',
};

interface Sink {
  columns: Column[];
  indexes: IndexDef[];
  ops: SchemaOp[];
  pkCols: string[];
  relations: RawRelation[];
  enums: RawEnum[];
}

function classifyBuilder(
  code: Code,
  file: SourceFile,
  table: { name: string; schema?: string },
  calls: Call[],
  sink: Sink,
  mode: 'create' | 'alter',
): void {
  const head = calls[0];
  const rest = calls.slice(1);
  const line = head.line;
  const src = { file: file.path, line };

  switch (head.name) {
    case 'dropColumn': {
      const c = stringArg(code, head.open, 0);
      if (c) sink.ops.push({ op: 'dropColumn', table, column: c, source: src });
      return;
    }
    case 'dropColumns': {
      for (const sp of code.args(head.open).positional) {
        const c = stringValue(sp.text);
        if (c) sink.ops.push({ op: 'dropColumn', table, column: c, source: src });
      }
      return;
    }
    case 'renameColumn': {
      const from = stringArg(code, head.open, 0);
      const to = stringArg(code, head.open, 1);
      if (from && to) sink.ops.push({ op: 'renameColumn', table, column: from, to, source: src });
      return;
    }
    case 'dropForeign': {
      const cols = firstArrayOrString(code, head.open);
      sink.ops.push({ op: 'dropForeignKey', table, ...(cols.length ? { columns: cols } : {}), source: src });
      return;
    }
    case 'dropUnique':
    case 'dropIndex':
    case 'dropPrimary':
    case 'dropTimestamps':
      return;
    case 'primary':
      sink.pkCols.push(...firstArrayOrString(code, head.open));
      return;
    case 'unique': {
      const cols = firstArrayOrString(code, head.open);
      if (cols.length) sink.indexes.push({ columns: cols, unique: true, source: src });
      return;
    }
    case 'index': {
      const cols = firstArrayOrString(code, head.open);
      const nm = stringArg(code, head.open, 1);
      if (cols.length) sink.indexes.push({ ...(nm ? { name: nm } : {}), columns: cols, unique: false, source: src });
      return;
    }
    case 'foreign': {
      addForeignKey(code, table, firstArrayOrString(code, head.open), rest, sink, src);
      return;
    }
    case 'timestamps': {
      for (const c of ['created_at', 'updated_at']) {
        if (!sink.columns.some((x) => x.name === c)) sink.columns.push(column(c, 'timestamp', { nullable: true, source: src }));
      }
      return;
    }
    default:
      break;
  }

  const type = TYPE_METHODS[head.name];
  if (type === undefined && head.name !== 'specificType') return;
  const colName = stringArg(code, head.open, 0) ?? (head.name === 'increments' || head.name === 'bigIncrements' ? 'id' : undefined);
  if (!colName) return;
  const built = buildMigrationColumn(code, file, head, rest, colName, type, line);
  if (head.name === 'enu' || head.name === 'enum') {
    const arr = code.args(head.open).positional.find((p) => p.text.startsWith('['));
    if (arr) {
      const values = readStringArray(code, arr.start);
      if (values.length) {
        const enumName = `${table.name}_${colName}`;
        built.col.enumRef = enumName;
        sink.enums.push({ name: enumName, values, source: src });
      }
    }
  }
  if (mode === 'alter' && rest.some((c) => c.name === 'alter')) {
    sink.ops.push({
      op: 'alterColumn',
      table,
      column: built.col.name,
      set: {
        ...(built.col.type ? { type: built.col.type } : {}),
        nullable: built.col.nullable,
        ...(built.col.unique ? { unique: true } : {}),
        ...(built.col.default !== undefined ? { default: built.col.default } : {}),
      },
      source: src,
    });
    return;
  }
  sink.columns.push(built.col);
  if (built.relation) {
    built.relation.from = { name: table.name, schema: table.schema };
    sink.relations.push(built.relation);
  }
}

function buildMigrationColumn(
  code: Code,
  file: SourceFile,
  head: Call,
  rest: Call[],
  colName: string,
  typeBase: string | undefined,
  line: number,
): { col: Column; relation?: RawRelation } {
  const src = { file: file.path, line };
  let type = typeBase ?? '';
  if (head.name === 'specificType') type = stringArg(code, head.open, 1) ?? '';
  if (head.name === 'string') {
    const len = numberValue(code.args(head.open).positional[1]?.text);
    if (len != null) type = `varchar(${len})`;
  } else if (head.name === 'decimal' || head.name === 'float' || head.name === 'double') {
    const prec = numberValue(code.args(head.open).positional[1]?.text);
    const scale = numberValue(code.args(head.open).positional[2]?.text);
    if (prec != null) type = scale != null ? `${type}(${prec},${scale})` : `${type}(${prec})`;
  }
  const props: Partial<Column> = { source: src, nullable: true };
  if (head.name === 'increments' || head.name === 'bigIncrements') {
    props.primaryKey = true;
    props.generated = true;
    props.nullable = false;
  }
  let refCol: string | undefined;
  let refTable: string | undefined;
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  for (const c of rest) {
    switch (c.name) {
      case 'notNullable':
        props.nullable = false;
        break;
      case 'nullable':
        props.nullable = true;
        break;
      case 'unique':
        props.unique = true;
        break;
      case 'primary':
        props.primaryKey = true;
        props.nullable = false;
        break;
      case 'defaultTo':
        props.default = defaultExpr(code, c.open);
        break;
      case 'comment': {
        const cm = stringArg(code, c.open, 0);
        if (cm) props.comment = cm;
        break;
      }
      case 'references': {
        const r = stringArg(code, c.open, 0);
        if (r) {
          const dot = r.lastIndexOf('.');
          if (dot >= 0) {
            refTable = r.slice(0, dot);
            refCol = r.slice(dot + 1);
          } else refCol = r;
        }
        break;
      }
      case 'inTable':
        refTable = stringArg(code, c.open, 0) ?? refTable;
        break;
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
  const col = column(colName, type, props);
  let relation: RawRelation | undefined;
  if (refTable) {
    relation = {
      from: { name: '' },
      fromColumns: [colName],
      to: { name: shortName(refTable), schema: refTable.includes('.') ? refTable.split('.')[0] : undefined },
      toColumns: refCol ? [refCol] : [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
      optional: props.nullable,
      source: src,
    };
  }
  return { col, relation };
}

function addForeignKey(code: Code, table: { name: string; schema?: string }, cols: string[], rest: Call[], sink: Sink, src: { file: string; line: number }): void {
  let refCol: string | undefined;
  let refTable: string | undefined;
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  for (const c of rest) {
    if (c.name === 'references') {
      const r = stringArg(code, c.open, 0);
      if (r) {
        const dot = r.lastIndexOf('.');
        if (dot >= 0) {
          refTable = r.slice(0, dot);
          refCol = r.slice(dot + 1);
        } else refCol = r;
      }
    } else if (c.name === 'inTable') refTable = stringArg(code, c.open, 0) ?? refTable;
    else if (c.name === 'onDelete') onDelete = stringArg(code, c.open, 0);
    else if (c.name === 'onUpdate') onUpdate = stringArg(code, c.open, 0);
  }
  if (!refTable || !cols.length) return;
  sink.relations.push({
    from: { name: table.name, schema: table.schema },
    fromColumns: cols,
    to: { name: shortName(refTable), schema: refTable.includes('.') ? refTable.split('.')[0] : undefined },
    toColumns: refCol ? [refCol] : [],
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    source: src,
  });
}

function defaultExpr(code: Code, open: number): string | undefined {
  if (open < 0) return undefined;
  const sp = code.args(open).positional[0];
  if (!sp) return undefined;
  if (/raw\s*\(/.test(sp.text)) {
    const rawCall = callChain(code, sp.start, sp.end).find((c) => c.name === 'raw');
    if (rawCall) return stringArg(code, rawCall.open, 0) ?? sp.text;
  }
  return sp.text;
}

function firstArrayOrString(code: Code, open: number): string[] {
  if (open < 0) return [];
  const args = code.args(open);
  const arr = args.positional.find((p) => p.text.startsWith('['));
  if (arr) return readStringArray(code, arr.start);
  const s = args.positional[0] ? stringValue(args.positional[0].text) : undefined;
  return s ? [s] : [];
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
// Objection models
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RELATION_TYPES: Record<string, 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many'> = {
  BelongsToOneRelation: 'many-to-one',
  HasOneRelation: 'one-to-one',
  HasManyRelation: 'one-to-many',
  ManyToManyRelation: 'many-to-many',
  HasOneThroughRelation: 'one-to-one',
};

function parseObjection(code: Code, file: SourceFile): ParseResult {
  const result: ParseResult = { entities: [], relations: [], enums: [] };
  for (const cls of findClasses(code)) {
    const explicit = modelTableName(code, cls.bodyOpen, cls.bodyClose);
    const tableName = explicit ?? cls.name;
    result.entities.push({
      name: tableName,
      kind: 'table',
      modelName: cls.name,
      nameCertainty: explicit ? 2 : 0,
      columns: [],
      source: { file: file.path, line: cls.line },
    });
    parseRelationMappings(code, file, cls.bodyOpen, cls.bodyClose, result);
  }
  return result;
}

function modelTableName(code: Code, open: number, close: number): string | undefined {
  const m = code.masked;
  const slice = m.slice(open, close);
  const assign = /\bstatic\s+tableName\s*=\s*/.exec(slice);
  if (assign) {
    const at = open + assign.index + assign[0].length;
    const semi = m.indexOf(';', at);
    const end = semi < 0 || semi > close ? close : semi;
    const v = stringValue(code.span(at, end).text);
    if (v) return v;
  }
  const getter = /\bstatic\s+get\s+tableName\s*\(\s*\)\s*\{/.exec(slice);
  if (getter) {
    const brace = open + getter.index + getter[0].length - 1;
    const bclose = code.closing(brace);
    const body = code.stripped.slice(brace + 1, bclose < 0 ? close : bclose);
    const ret = /return\s+(['"][^'"]+['"])/.exec(body);
    if (ret) return stringValue(ret[1]);
  }
  return undefined;
}

function parseRelationMappings(code: Code, file: SourceFile, open: number, close: number, result: ParseResult): void {
  const m = code.masked;
  const slice = m.slice(open, close);
  const rm = /\bstatic\s+(?:get\s+)?relationMappings\b/.exec(slice);
  if (!rm) return;
  let p = open + rm.index + rm[0].length;
  while (p < close && /\s/.test(m[p])) p++;
  let objOpen = -1;
  if (m[p] === '(') {
    // getter / method: `relationMappings() { return { … } }`
    const ret = /\breturn\b/.exec(m.slice(p, close));
    if (ret) objOpen = m.indexOf('{', p + ret.index + 'return'.length);
  } else if (m[p] === '=' || m[p] === ':') {
    objOpen = m.indexOf('{', p);
  }
  if (objOpen < 0 || objOpen > close) return;
  for (const [, span] of code.object(objOpen)) {
    if (!span.text.startsWith('{')) continue;
    const def = code.object(span.start);
    const relRef = def.get('relation');
    const relClass = relRef ? shortName(relRef.text.replace(/\s+/g, '')) : undefined;
    const relType = relClass ? RELATION_TYPES[relClass] : undefined;
    const joinSpan = def.get('join');
    if (!relType || !joinSpan?.text.startsWith('{')) continue;
    const join = code.object(joinSpan.start);
    const from = stringValue(join.get('from')?.text ?? '');
    const to = stringValue(join.get('to')?.text ?? '');
    if (!from || !to) continue;
    const fromTable = tableOf(from);
    const toTable = tableOf(to);
    const fromCol = colOf(from);
    const toCol = colOf(to);
    if (!fromTable || !toTable) continue;
    const line = code.lineAt(span.start);
    const through = join.get('through');

    if (relType === 'many-to-many') {
      let pivot: string | undefined;
      if (through?.text.startsWith('{')) {
        const th = code.object(through.start);
        const thFrom = stringValue(th.get('from')?.text ?? '');
        pivot = thFrom ? tableOf(thFrom) : undefined;
      }
      result.relations.push({
        from: { name: fromTable },
        fromColumns: fromCol ? [fromCol] : [],
        to: { name: toTable },
        toColumns: toCol ? [toCol] : [],
        cardinality: 'many-to-many',
        kind: 'orm',
        ...(pivot ? { through: { name: pivot } } : {}),
        source: { file: file.path, line },
      });
    } else if (relClass === 'HasOneRelation') {
      result.relations.push({
        from: { name: toTable },
        fromColumns: toCol ? [toCol] : [],
        to: { name: fromTable },
        toColumns: fromCol ? [fromCol] : [],
        cardinality: 'one-to-one',
        kind: 'orm',
        source: { file: file.path, line },
      });
    } else {
      result.relations.push({
        from: { name: fromTable },
        fromColumns: fromCol ? [fromCol] : [],
        to: { name: toTable },
        toColumns: toCol ? [toCol] : [],
        cardinality: relType,
        kind: 'orm',
        source: { file: file.path, line },
      });
    }
  }
}

function colOf(ref: string): string | undefined {
  const parts = ref.split('.');
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}

function tableOf(ref: string): string | undefined {
  const parts = ref.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

export const knexParser: SchemaParser = { kind: KIND, extensions: EXTENSIONS, detect, parse };
