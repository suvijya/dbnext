/**
 * Drizzle ORM schema parser (`kind: 'drizzle'`, definition origin).
 *
 * Reads `pgTable` / `mysqlTable` / `sqliteTable` / `singlestoreTable` (and schema-scoped
 * `pgSchema('x').table(...)`), column builder chains (`.primaryKey()`, `.notNull()`, `.unique()`,
 * `.default(...)`, `.references(...)`, `.array()`, generated columns), the third-argument index /
 * constraint callback (`index`, `uniqueIndex`, `unique`, `primaryKey`, `foreignKey`), `pgEnum`,
 * `pgView`, and `relations(...)`. The exported variable becomes the `modelName`; the first string
 * argument is the real table name.
 */

import type { Column, EngineId, EngineHint, ParseResult, RawEntity, SourceFile } from '../core/model';
import { column, type SchemaParser } from '../core/parser';
import { Code, numberValue, stringValue } from '../core/text';
import { callChain, type Call } from './shared/jsorm';

const KIND = 'drizzle' as const;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

const TABLE_FNS = new Set(['pgTable', 'mysqlTable', 'sqliteTable', 'singlestoreTable']);
const VIEW_FNS = new Set(['pgView', 'mysqlView', 'sqliteView', 'pgMaterializedView']);

function dialectEngine(fnOrSchema: string): EngineId | undefined {
  if (fnOrSchema.startsWith('pg')) return 'postgresql';
  if (fnOrSchema.startsWith('mysql')) return 'mysql';
  if (fnOrSchema.startsWith('sqlite')) return 'sqlite';
  if (fnOrSchema.startsWith('singlestore')) return 'mysql';
  return undefined;
}

function detect(file: SourceFile): boolean {
  const t = file.text;
  const hasTableFn = /\b(?:pgTable|mysqlTable|sqliteTable|singlestoreTable)\s*\(/.test(t);
  if (/drizzle-orm/.test(t)) {
    return (
      hasTableFn ||
      /\b(?:pgEnum|pgSchema|mysqlSchema|pgView|mysqlView|sqliteView|relations)\s*\(/.test(t) ||
      /\b(?:pgTableCreator|mysqlTableCreator|sqliteTableCreator|singlestoreTableCreator)\b/.test(t) ||
      /\b(?:pgTable|mysqlTable|sqliteTable|singlestoreTable)\s+as\s+[A-Za-z_$]/.test(t)
    );
  }
  return hasTableFn;
}

/** Drizzle core functions whose local alias we track (`import { pgTable as table }`). */
const DRIZZLE_FNS = new Set([
  'pgTable', 'mysqlTable', 'sqliteTable', 'singlestoreTable',
  'pgView', 'mysqlView', 'sqliteView', 'pgMaterializedView',
  'pgEnum', 'pgSchema', 'mysqlSchema', 'relations',
  'pgTableCreator', 'mysqlTableCreator', 'sqliteTableCreator', 'singlestoreTableCreator',
]);

const CREATOR_FNS = new Set(['pgTableCreator', 'mysqlTableCreator', 'sqliteTableCreator', 'singlestoreTableCreator']);

/** Local-name → canonical-name map for `import { pgTable as table } from 'drizzle-orm/pg-core'`. */
function drizzleAliases(code: Code): Map<string, string> {
  const alias = new Map<string, string>();
  const re = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:drizzle-orm[^'"]*)['"]/g;
  for (const mt of code.text.matchAll(re)) {
    for (const part of mt[1].split(',')) {
      const am = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
      if (am && DRIZZLE_FNS.has(am[1])) alias.set(am[2], am[1]);
    }
  }
  return alias;
}

/** Spread identifiers (`...timestamps`) at the top level of the object literal opening at `open`. */
function spreadVarsAtTop(code: Code, open: number): string[] {
  const inner = code.inner(open);
  if (!inner) return [];
  const out: string[] = [];
  for (const part of code.split(inner.start, inner.end, ',')) {
    const mm = /^\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(part.text);
    if (mm) out.push(mm[1]);
  }
  return out;
}

interface SchemaVar {
  schema: string;
  engine?: EngineId;
}

const CONST_RE = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** `t.authorId` / `users.id` / `authorId` → `authorId`. */
function propAfterDot(text: string): string {
  const s = text.trim().replace(/[,\s]+$/, '');
  const dot = s.lastIndexOf('.');
  return (dot >= 0 ? s.slice(dot + 1) : s).trim();
}

/** First segment of `users.id` / `() => users.id` → `users`. */
function refTarget(text: string): { model: string; column?: string } | undefined {
  const arrow = /=>\s*(.+)$/.exec(text.trim());
  const body = (arrow ? arrow[1] : text).trim().replace(/[)\s]+$/, '');
  const m = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(body);
  if (m) return { model: m[1], column: m[2] };
  const id = /^([A-Za-z_$][\w$]*)/.exec(body);
  return id ? { model: id[1] } : undefined;
}

function optionsArg(code: Code, open: number): Map<string, { start: number; end: number; text: string }> | undefined {
  if (open < 0) return undefined;
  for (const p of code.args(open).positional) {
    if (p.text.startsWith('{')) return code.object(p.start);
  }
  return undefined;
}

function readStringArray(code: Code, open: number): string[] {
  const out: string[] = [];
  for (const it of code.items(open)) {
    const v = stringValue(it.text);
    if (v !== undefined) out.push(v);
  }
  return out;
}

interface TableCtx {
  name: string;
  model: string;
  schema?: string;
  keyToColumn: Map<string, string>;
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'js');
  const result: ParseResult = { entities: [], relations: [], enums: [] };
  const m = code.masked;

  const schemaVars = new Map<string, SchemaVar>();
  const enumVars = new Map<string, string>(); // var → sql enum name
  const varToTable = new Map<string, { name: string; schema?: string }>();
  const engines = new Map<EngineId, EngineHint>();
  const tableDecls: { varName: string; schemaVar?: string; fn: string; fnc: string; engine?: EngineId; open: number; line: number }[] = [];
  const tableColumns = new Map<string, Map<string, string>>(); // var → (key → real column name)

  const alias = drizzleAliases(code);
  const canonical = (fn: string) => alias.get(fn) ?? fn;
  const factories = new Map<string, EngineId | undefined>(); // table-creator var → dialect engine
  const objectConsts = new Map<string, number>(); // const name → `{` offset (shared column groups for spreads)
  for (const mt of m.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
    objectConsts.set(mt[1], mt.index + mt[0].length - 1);
  }

  // First pass: classify every top-level const declaration.
  for (const match of m.matchAll(CONST_RE)) {
    const [, varName, schemaVar, fn] = match;
    const open = match.index + match[0].length - 1;
    const line = code.lineAt(match.index);
    const cfn = canonical(fn);
    if (!schemaVar && CREATOR_FNS.has(cfn)) {
      // `const createTable = pgTableCreator((name) => …)` – a table factory (create-t3-app pattern).
      factories.set(varName, dialectEngine(cfn));
      continue;
    }
    if (!schemaVar && (cfn === 'pgSchema' || cfn === 'mysqlSchema')) {
      const s = stringArgAt(code, open, 0);
      if (s) schemaVars.set(varName, { schema: s, engine: dialectEngine(cfn) });
      continue;
    }
    if (!schemaVar && cfn === 'pgEnum') {
      const name = stringArgAt(code, open, 0);
      const valuesSpan = code.args(open).positional[1];
      if (name && valuesSpan?.text.startsWith('[')) {
        enumVars.set(varName, name);
        result.enums.push({ name, values: readStringArray(code, valuesSpan.start), source: { file: file.path, line } });
      }
      continue;
    }
    const isSchemaTable = !!schemaVar && schemaVars.has(schemaVar) && (fn === 'table' || fn === 'view');
    const isFactoryTable = !schemaVar && factories.has(fn);
    if (TABLE_FNS.has(cfn) || VIEW_FNS.has(cfn) || isSchemaTable || isFactoryTable) {
      const sv = schemaVar ? schemaVars.get(schemaVar) : undefined;
      const engine = sv?.engine ?? (isFactoryTable ? factories.get(fn) : dialectEngine(cfn));
      tableDecls.push({ varName, schemaVar, fn, fnc: cfn, engine, open, line });
      const name = stringArgAt(code, open, 0);
      if (name) varToTable.set(varName, { name, schema: sv?.schema });
    }
  }

  // Second pass: build entities.
  for (const decl of tableDecls) {
    const sv = decl.schemaVar ? schemaVars.get(decl.schemaVar) : undefined;
    const engine = decl.engine;
    const tableName = stringArgAt(code, decl.open, 0) ?? decl.varName;
    const isView = VIEW_FNS.has(decl.fnc) || decl.fn === 'view';
    const ctx: TableCtx = { name: tableName, model: decl.varName, schema: sv?.schema, keyToColumn: new Map() };
    const positional = code.args(decl.open).positional;
    const colSpec = resolveColumnObject(code, positional);
    const columns: Column[] = [];
    const addColumn = (key: string, span: { start: number; end: number; text: string }) => {
      if (ctx.keyToColumn.has(key)) return;
      const built = buildColumn(code, file, key, span, ctx, enumVars, result, colSpec?.helper);
      if (built) {
        ctx.keyToColumn.set(key, built.name);
        columns.push(built);
      }
    };
    if (colSpec) {
      for (const [key, span] of code.object(colSpec.open)) addColumn(key, span);
      // Columns mixed in via spread of a shared object (`{ ...timestamps, id }`).
      for (const spread of spreadVarsAtTop(code, colSpec.open)) {
        const spreadOpen = objectConsts.get(spread);
        if (spreadOpen === undefined) continue;
        for (const [key, span] of code.object(spreadOpen)) addColumn(key, span);
      }
    }
    // Third argument: index / constraint callback.
    const indexes: NonNullable<RawEntity['indexes']> = [];
    const extras = positional.find((_, i) => i >= 2);
    if (extras) parseExtras(code, file, extras, ctx, columns, indexes, result);

    if (engine) {
      if (!engines.has(engine)) engines.set(engine, { engine, line: decl.line, detail: `Drizzle ${decl.fnc}` });
    }
    const entity: RawEntity = {
      name: tableName,
      kind: isView ? 'view' : 'table',
      modelName: decl.varName,
      nameCertainty: 2,
      columns,
      source: { file: file.path, line: decl.line },
    };
    if (sv?.schema) entity.schema = sv.schema;
    if (engine) entity.engine = engine;
    if (indexes.length) entity.indexes = indexes;
    result.entities.push(entity);
    tableColumns.set(decl.varName, ctx.keyToColumn);
  }

  parseRelations(code, file, varToTable, tableColumns, result);
  if (engines.size) result.engines = [...engines.values()];
  return result;
}

function stringArgAt(code: Code, open: number, idx: number): string | undefined {
  if (open < 0) return undefined;
  const sp = code.args(open).positional[idx];
  return sp ? stringValue(sp.text) : undefined;
}

/**
 * Locates the column-definitions object of a table call. Two forms are supported:
 *  - object literal: `pgTable('t', { id: … })`
 *  - column-builder callback (Drizzle ≥ 0.33, the create-t3-app default):
 *    `pgTable('t', (d) => ({ id: d.serial() }))` — `helper` is the callback parameter (`d`), so the
 *    `d.`-prefixed builder chains can be read.
 */
function resolveColumnObject(
  code: Code,
  positional: { start: number; end: number; text: string }[],
): { open: number; helper?: string } | undefined {
  for (let i = 1; i < positional.length; i++) {
    if (positional[i].text.startsWith('{')) return { open: positional[i].start };
  }
  const p = positional[1];
  if (!p || !p.text.startsWith('(')) return undefined;
  const helper = /^\(\s*([A-Za-z_$][\w$]*)/.exec(p.text)?.[1];
  const m = code.masked;
  const arrow = m.indexOf('=>', p.start);
  if (arrow < 0 || arrow >= p.end) return undefined;
  let j = arrow + 2;
  while (j < p.end && /\s/.test(m[j])) j++;
  if (m[j] === '(') {
    const inner = code.inner(j);
    if (inner) {
      let k = inner.start;
      while (k < inner.end && /\s/.test(m[k])) k++;
      if (m[k] === '{') return { open: k, helper };
    }
  } else if (m[j] === '{') {
    // block body: `(d) => { return { … } }`
    const ret = m.indexOf('return', j);
    if (ret >= 0 && ret < p.end) {
      const b = m.indexOf('{', ret + 'return'.length);
      if (b >= 0 && b < p.end) return { open: b, helper };
    }
  }
  return undefined;
}

function buildColumn(
  code: Code,
  file: SourceFile,
  key: string,
  span: { start: number; end: number; text: string },
  ctx: TableCtx,
  enumVars: Map<string, string>,
  result: ParseResult,
  helper?: string,
): Column | undefined {
  let chainStart = span.start;
  if (helper) {
    // `d.serial('id').primaryKey()` – skip the callback parameter prefix so the chain head is the type.
    const pref = new RegExp(`^\\s*${helper}\\s*\\.\\s*`).exec(code.masked.slice(span.start, span.end));
    if (pref) chainStart = span.start + pref[0].length;
  }
  const chain = callChain(code, chainStart, span.end);
  if (!chain.length) return undefined;
  const head = chain[0];
  const headOpts = optionsArg(code, head.open);
  let name = stringArgAt(code, head.open, 0) ?? key;
  const line = code.lineAt(span.start);
  const props: Partial<Column> = { source: { file: file.path, line }, nullable: true };
  let type = head.name;
  let enumRef: string | undefined;

  if (enumVars.has(head.name)) {
    type = enumVars.get(head.name)!;
    enumRef = type;
  } else if (head.name === 'mysqlEnum' || head.name === 'pgEnum') {
    const arr = code.args(head.open).positional.find((p) => p.text.startsWith('['));
    if (arr) {
      const values = readStringArray(code, arr.start);
      const enumName = `${ctx.name}_${name}`;
      result.enums.push({ name: enumName, values, source: { file: file.path, line } });
      enumRef = enumName;
      type = 'enum';
    }
  } else {
    const len = numberValue(headOpts?.get('length')?.text);
    const prec = numberValue(headOpts?.get('precision')?.text);
    const scale = numberValue(headOpts?.get('scale')?.text);
    if (len != null) type = `${type}(${len})`;
    else if (prec != null) type = scale != null ? `${type}(${prec},${scale})` : `${type}(${prec})`;
    const enumOpt = headOpts?.get('enum');
    if (enumOpt?.text.startsWith('[')) {
      const values = readStringArray(code, enumOpt.start);
      const enumName = `${ctx.name}_${name}`;
      result.enums.push({ name: enumName, values, source: { file: file.path, line } });
      enumRef = enumName;
    }
  }

  for (const call of chain.slice(1)) {
    switch (call.name) {
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
      case 'array':
        props.isArray = true;
        break;
      case 'defaultNow':
        props.default = 'now()';
        break;
      case 'defaultRandom':
        props.default = 'gen_random_uuid()';
        break;
      case 'default': {
        const sp = code.args(call.open).positional[0];
        if (sp) props.default = sp.text;
        break;
      }
      case '$defaultFn':
      case '$default':
        props.generated = true;
        break;
      case 'generatedAlwaysAs':
      case 'generatedAlwaysAsIdentity':
      case 'generatedByDefaultAsIdentity':
      case 'autoincrement':
        props.generated = true;
        break;
      case 'references': {
        const first = code.args(call.open).positional[0];
        const target = first ? refTarget(first.text) : undefined;
        if (target) {
          const opts = optionsArg(code, call.open);
          const onDelete = stringValue(opts?.get('onDelete')?.text);
          const onUpdate = stringValue(opts?.get('onUpdate')?.text);
          result.relations.push({
            from: { model: ctx.model, name: ctx.name, schema: ctx.schema },
            fromColumns: [name],
            to: { model: target.model },
            toColumns: target.column ? [target.column] : [],
            cardinality: 'many-to-one',
            kind: 'foreign-key',
            ...(onDelete ? { onDelete } : {}),
            ...(onUpdate ? { onUpdate } : {}),
            source: { file: file.path, line },
          });
        }
        break;
      }
      default:
        break;
    }
  }
  if (/^serial$/i.test(head.name) || /serial/i.test(head.name)) props.generated = true;
  if (props.isArray && type && !/\[\]$/.test(type) && type !== 'enum') type = `${type}[]`;
  const col = column(name, type, props);
  if (enumRef) col.enumRef = enumRef;
  return col;
}

/** Index / constraint callback: `(t) => [ … ]` or `(t) => ({ … })`. */
function parseExtras(
  code: Code,
  file: SourceFile,
  span: { start: number; end: number; text: string },
  ctx: TableCtx,
  columns: Column[],
  indexes: NonNullable<RawEntity['indexes']>,
  result: ParseResult,
): void {
  const m = code.masked;
  const arrow = m.indexOf('=>', span.start);
  if (arrow < 0 || arrow > span.end) return;
  let i = arrow + 2;
  while (i < span.end && (m[i] === ' ' || m[i] === '\t' || m[i] === '\n' || m[i] === '\r')) i++;
  let itemSpans: { start: number; end: number; text: string }[] = [];
  if (m[i] === '[') {
    itemSpans = code.items(i);
  } else if (m[i] === '(') {
    const inner = code.inner(i);
    if (inner) {
      let j = inner.start;
      while (j < inner.end && (m[j] === ' ' || m[j] === '\t' || m[j] === '\n' || m[j] === '\r')) j++;
      if (m[j] === '[') itemSpans = code.items(j);
      else if (m[j] === '{') itemSpans = [...code.object(j).values()];
    }
  } else if (m[i] === '{') {
    itemSpans = [...code.object(i).values()];
  }
  const line = code.lineAt(span.start);
  for (const item of itemSpans) {
    const chain = callChain(code, item.start, item.end);
    if (!chain.length) continue;
    const head = chain[0];
    if (head.name === 'index' || head.name === 'uniqueIndex' || head.name === 'unique') {
      const unique = head.name !== 'index';
      const name = stringArgAt(code, head.open, 0);
      const onCall = chain.find((c) => c.name === 'on');
      const cols = onCall ? onColumns(code, onCall, ctx) : [];
      if (cols.length) indexes.push({ name, unique, columns: cols, source: { file: file.path, line } });
    } else if (head.name === 'primaryKey') {
      const cols = constraintColumns(code, head, ctx);
      for (const c of cols) {
        const col = columns.find((x) => x.name === c);
        if (col) {
          col.primaryKey = true;
          col.nullable = false;
        }
      }
    } else if (head.name === 'foreignKey') {
      parseForeignKey(code, file, head, chain, ctx, result, line);
    }
  }
}

function onColumns(code: Code, onCall: Call, ctx: TableCtx): string[] {
  if (onCall.open < 0) return [];
  const out: string[] = [];
  for (const p of code.args(onCall.open).positional) {
    const prop = propAfterDot(p.text);
    if (prop) out.push(ctx.keyToColumn.get(prop) ?? prop);
  }
  return out;
}

function constraintColumns(code: Code, head: Call, ctx: TableCtx): string[] {
  if (head.open < 0) return [];
  const opts = optionsArg(code, head.open);
  const colsSpan = opts?.get('columns');
  if (colsSpan?.text.startsWith('[')) {
    return code.items(colsSpan.start).map((it) => {
      const prop = propAfterDot(it.text);
      return ctx.keyToColumn.get(prop) ?? prop;
    });
  }
  // positional columns: primaryKey({ columns }) is the main form; fall back to positional refs.
  return code.args(head.open).positional
    .filter((p) => !p.text.startsWith('{'))
    .map((p) => {
      const prop = propAfterDot(p.text);
      return ctx.keyToColumn.get(prop) ?? prop;
    })
    .filter(Boolean);
}

function parseForeignKey(
  code: Code,
  file: SourceFile,
  head: Call,
  chain: Call[],
  ctx: TableCtx,
  result: ParseResult,
  line: number,
): void {
  const opts = optionsArg(code, head.open);
  if (!opts) return;
  const colsSpan = opts.get('columns');
  const foreignSpan = opts.get('foreignColumns');
  if (!colsSpan?.text.startsWith('[') || !foreignSpan?.text.startsWith('[')) return;
  const fromColumns = code.items(colsSpan.start).map((it) => {
    const prop = propAfterDot(it.text);
    return ctx.keyToColumn.get(prop) ?? prop;
  });
  const foreign = code.items(foreignSpan.start).map((it) => refTarget(it.text)).filter((x): x is { model: string; column?: string } => !!x);
  if (!fromColumns.length || !foreign.length) return;
  const onDelete = stringValue(opts.get('onDelete')?.text) ?? onChainValue(code, chain, 'onDelete');
  const onUpdate = stringValue(opts.get('onUpdate')?.text) ?? onChainValue(code, chain, 'onUpdate');
  result.relations.push({
    from: { model: ctx.model, name: ctx.name, schema: ctx.schema },
    fromColumns,
    to: { model: foreign[0].model },
    toColumns: foreign.map((f) => f.column).filter((c): c is string => !!c),
    cardinality: 'many-to-one',
    kind: 'foreign-key',
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    source: { file: file.path, line },
  });
}

function onChainValue(code: Code, chain: Call[], method: string): string | undefined {
  const call = chain.find((c) => c.name === method);
  return call ? stringArgAt(code, call.open, 0) : undefined;
}

function parseRelations(
  code: Code,
  file: SourceFile,
  varToTable: Map<string, { name: string; schema?: string }>,
  tableColumns: Map<string, Map<string, string>>,
  result: ParseResult,
): void {
  const m = code.masked;
  const re = /\b(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*relations\s*\(/g;
  for (const match of m.matchAll(re)) {
    const open = m.indexOf('(', match.index + match[0].length - 1);
    if (open < 0) continue;
    const args = code.args(open);
    const tableRef = args.positional[0];
    if (!tableRef) continue;
    const tableVar = /^([A-Za-z_$][\w$]*)/.exec(tableRef.text)?.[1];
    if (!tableVar) continue;
    const self = varToTable.get(tableVar);
    const line = code.lineAt(match.index);
    const cbSpan = args.positional[1];
    if (!cbSpan) continue;
    const arrow = m.indexOf('=>', cbSpan.start);
    if (arrow < 0 || arrow > cbSpan.end) continue;
    let i = arrow + 2;
    while (i < cbSpan.end && (m[i] === ' ' || m[i] === '\t' || m[i] === '\n' || m[i] === '\r')) i++;
    if (m[i] === '(') {
      const inner = code.inner(i);
      if (inner) {
        let j = inner.start;
        while (j < inner.end && (m[j] === ' ' || m[j] === '\t' || m[j] === '\n' || m[j] === '\r')) j++;
        if (m[j] === '{') parseRelationObject(code, file, j, tableVar, self, tableColumns, result, line);
      }
    } else if (m[i] === '{') {
      parseRelationObject(code, file, i, tableVar, self, tableColumns, result, line);
    }
  }
}

function parseRelationObject(
  code: Code,
  file: SourceFile,
  objOpen: number,
  tableVar: string,
  self: { name: string; schema?: string } | undefined,
  tableColumns: Map<string, Map<string, string>>,
  result: ParseResult,
  line: number,
): void {
  const selfCols = tableColumns.get(tableVar);
  for (const [, span] of code.object(objOpen)) {
    const chain = callChain(code, span.start, span.end);
    if (!chain.length || chain[0].name !== 'one') continue;
    const head = chain[0];
    const args = code.args(head.open);
    const targetVar = /^([A-Za-z_$][\w$]*)/.exec(args.positional[0]?.text ?? '')?.[1];
    const opts = optionsArg(code, head.open);
    const fieldsSpan = opts?.get('fields');
    const refsSpan = opts?.get('references');
    if (!targetVar || !fieldsSpan?.text.startsWith('[') || !refsSpan?.text.startsWith('[')) continue;
    const targetCols = tableColumns.get(targetVar);
    const fromColumns = code.items(fieldsSpan.start).map((it) => {
      const p = propAfterDot(it.text);
      return selfCols?.get(p) ?? p;
    }).filter(Boolean);
    const toColumns = code.items(refsSpan.start).map((it) => {
      const p = propAfterDot(it.text);
      return targetCols?.get(p) ?? p;
    }).filter(Boolean);
    if (!fromColumns.length) continue;
    result.relations.push({
      from: { model: tableVar, name: self?.name, schema: self?.schema },
      fromColumns,
      to: { model: targetVar },
      toColumns,
      cardinality: 'many-to-one',
      kind: 'orm',
      source: { file: file.path, line },
    });
  }
}

export const drizzleParser: SchemaParser = { kind: KIND, extensions: EXTENSIONS, detect, parse };
