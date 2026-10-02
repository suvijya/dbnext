/**
 * Liquibase parser. Reads changelogs in XML, YAML and JSON and turns their `changeSet` change
 * types into migration entities / operations.
 *
 * Supported changes: createTable, createView, addColumn, dropColumn, renameColumn, renameTable,
 * dropTable, addForeignKeyConstraint, dropForeignKeyConstraint, addPrimaryKey, addNotNullConstraint,
 * dropNotNullConstraint, addUniqueConstraint, createIndex, modifyDataType, addDefaultValue, with
 * their column / constraint attributes. `<rollback>` and `<include>/<includeAll>` are ignored.
 *
 * The XML is read with a small tolerant tokenizer (no DOMParser); YAML with a minimal
 * indentation-based parser; JSON with `JSON.parse`. Pure, synchronous, never throws.
 */

import type { Column, ParseResult, RawEntity, RawRelation, SourceFile, SourceRef } from '../core/model';
import { column, extOf, type SchemaParser } from '../core/parser';
import { LineIndex } from '../core/text';
import { collapseWs, splitCsv } from './shared/schemas';

function detect(file: SourceFile): boolean {
  return file.text.includes('databaseChangeLog');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Common node tree
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LNode {
  name: string;
  attrs: Map<string, string>;
  children: LNode[];
  line: number;
}

const node = (name: string, line: number): LNode => ({ name, attrs: new Map(), children: [], line });
const child = (n: LNode, name: string): LNode | undefined => n.children.find((c) => c.name === name);
const children = (n: LNode, name: string): LNode[] => n.children.filter((c) => c.name === name);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// XML tokenizer
// ─────────────────────────────────────────────────────────────────────────────────────────────

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x?\d*[0-9a-fA-F]*);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

const localName = (name: string): string => {
  const c = name.indexOf(':');
  return c >= 0 ? name.slice(c + 1) : name;
};

function parseTag(inner: string): { name: string; attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  const nameMatch = /^\s*([^\s/>]+)/.exec(inner);
  const name = nameMatch ? localName(nameMatch[1]) : '';
  for (const m of inner.matchAll(/([^\s=/]+)\s*=\s*"([^"]*)"|([^\s=/]+)\s*=\s*'([^']*)'/g)) {
    const key = localName(m[1] ?? m[3]);
    attrs.set(key, unescapeXml(m[2] ?? m[4] ?? ''));
  }
  return { name, attrs };
}

function findTagEnd(text: string, i: number): number {
  let q = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  return -1;
}

function parseXml(text: string): LNode[] {
  const index = new LineIndex(text);
  const root = node('#root', 0);
  const stack: LNode[] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<!', i) || text.startsWith('<?', i)) {
      const e = text.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const e = text.indexOf('>', i);
      const name = localName(text.slice(i + 2, e < 0 ? n : e).trim());
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    const close = findTagEnd(text, i);
    if (close < 0) break;
    const selfClose = text[close - 1] === '/';
    const { name, attrs } = parseTag(text.slice(i + 1, selfClose ? close - 1 : close));
    if (name) {
      const el = node(name, index.lineAt(i));
      el.attrs = attrs;
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
    }
    i = close + 1;
  }
  return root.children;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// YAML / JSON → node tree
// ─────────────────────────────────────────────────────────────────────────────────────────────

type JVal = string | number | boolean | null | JVal[] | { [k: string]: JVal };

const isObject = (v: JVal): v is { [k: string]: JVal } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Finds the next line (0-based) of a key token in document order, best-effort. */
class LineFinder {
  private readonly index: LineIndex;
  private pos = 0;
  constructor(private readonly text: string) {
    this.index = new LineIndex(text);
  }
  find(tokens: string[]): number {
    let best = -1;
    for (const tok of tokens) {
      const i = this.text.indexOf(tok, this.pos);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best < 0) return this.index.lineAt(this.pos);
    this.pos = best + 1;
    return this.index.lineAt(best);
  }
}

/** Keys that must not be descended into (they hold the inverse / preconditions, not real changes). */
const SKIP_KEYS = new Set(['rollback', 'preconditions', 'modifysql', 'validchecksum']);

function toNode(name: string, value: JVal, finder: LineFinder, json: boolean): LNode {
  const line = finder.find(json ? [`"${name}"`] : [`${name}:`, `${name} :`]);
  const el = node(name, line);
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.has(k.toLowerCase())) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (isObject(item)) {
            for (const [ik, iv] of Object.entries(item)) {
              if (!SKIP_KEYS.has(ik.toLowerCase())) el.children.push(toNode(ik, iv, finder, json));
            }
          }
        }
      } else if (isObject(v)) {
        el.children.push(toNode(k, v, finder, json));
      } else {
        el.attrs.set(k, v === null ? '' : String(v));
      }
    }
  }
  return el;
}

function changeSetsFromJVal(root: JVal, finder: LineFinder, json: boolean): LNode[] {
  if (!isObject(root)) return [];
  const dcl = (root as { databaseChangeLog?: JVal }).databaseChangeLog;
  const items = Array.isArray(dcl) ? dcl : dcl !== undefined ? [dcl] : [];
  const out: LNode[] = [];
  for (const item of items) {
    if (isObject(item) && 'changeSet' in item) out.push(toNode('changeSet', item.changeSet as JVal, finder, json));
  }
  return out;
}

// ── minimal YAML ──

interface YLine {
  indent: number;
  text: string;
  line: number;
}

function stripComment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function tokenizeYaml(text: string): YLine[] {
  const out: YLine[] = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i].replace(/\r$/, '').replace(/\t/g, '  ');
    line = stripComment(line);
    if (!line.trim() || /^(---|\.\.\.)\s*$/.test(line.trim()) || line.trimStart().startsWith('%')) continue;
    const indent = line.length - line.trimStart().length;
    out.push({ indent, text: line.trim(), line: i });
  }
  return out;
}

function parseScalar(s: string): JVal {
  const t = s.trim();
  if (t === '' || t === '~' || t.toLowerCase() === 'null') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\(["\\nrt])/g, (_x, c: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c] ?? c) : inner.replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function splitKeyValue(text: string): { key: string; value: string } | undefined {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?)\s*:(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return undefined;
  let key = m[1].trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  return { key, value: (m[2] ?? '').trim() };
}

function parseYaml(text: string): JVal {
  const lines = tokenizeYaml(text);
  let idx = 0;

  const parseValue = (minIndent: number): JVal => {
    const ln = lines[idx];
    if (!ln) return null;
    if (ln.text === '-' || ln.text.startsWith('- ')) {
      return ln.indent >= minIndent ? parseList(ln.indent) : null;
    }
    return ln.indent > minIndent ? parseMap(ln.indent) : parseMap(ln.indent); // keys deeper than parent
  };

  const parseList = (indent: number): JVal[] => {
    const arr: JVal[] = [];
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent !== indent || !(ln.text === '-' || ln.text.startsWith('- '))) break;
      const after = ln.text === '-' ? '' : ln.text.slice(2).trim();
      if (after === '') {
        idx++;
        arr.push(parseValue(indent));
      } else if (splitKeyValue(after)) {
        const contentIndent = indent + (ln.text.length - after.length);
        lines[idx] = { indent: contentIndent, text: after, line: ln.line };
        arr.push(parseMap(contentIndent));
      } else {
        idx++;
        arr.push(parseScalar(after));
      }
    }
    return arr;
  };

  const parseMap = (indent: number): JVal => {
    const obj: { [k: string]: JVal } = {};
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent !== indent) break;
      const kv = splitKeyValue(ln.text);
      if (!kv) {
        idx++;
        continue;
      }
      idx++;
      if (kv.value !== '') {
        obj[kv.key] = parseScalar(kv.value);
      } else {
        const next = lines[idx];
        if (next && (next.text === '-' || next.text.startsWith('- ')) && next.indent >= indent) {
          obj[kv.key] = parseList(next.indent);
        } else if (next && next.indent > indent) {
          obj[kv.key] = parseMap(next.indent);
        } else {
          obj[kv.key] = null;
        }
      }
    }
    return obj;
  };

  if (!lines.length) return null;
  return parseValue(-1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Emitter: change nodes → entities / ops / relations
// ─────────────────────────────────────────────────────────────────────────────────────────────

function normType(raw: string | undefined): string {
  if (!raw) return '';
  return collapseWs(raw.replace(/^java\.sql\.Types\./i, ''));
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^true$/i.test(v.trim());

function tableRef(n: LNode): { name: string; schema?: string } | undefined {
  const name = n.attrs.get('tableName');
  if (!name) return undefined;
  const schema = n.attrs.get('schemaName');
  return { name, ...(schema ? { schema } : {}) };
}

function columnDefault(c: LNode): string | undefined {
  for (const key of ['defaultValue', 'defaultValueNumeric', 'defaultValueBoolean', 'defaultValueComputed', 'defaultValueDate']) {
    const v = c.attrs.get(key);
    if (v !== undefined) return v;
  }
  return undefined;
}

function buildColumn(c: LNode, file: string): { col: Column; fk?: RawRelation } {
  const name = c.attrs.get('name') ?? '';
  const type = normType(c.attrs.get('type'));
  const props: Partial<Column> = { source: { file, line: c.line } };
  const cons = child(c, 'constraints');
  let nullable = true;
  if (cons) {
    if (truthy(cons.attrs.get('primaryKey'))) {
      props.primaryKey = true;
      nullable = false;
    }
    const nn = cons.attrs.get('nullable');
    if (nn !== undefined) nullable = !/^false$/i.test(nn.trim());
    if (truthy(cons.attrs.get('unique'))) props.unique = true;
  }
  props.nullable = nullable;
  if (truthy(c.attrs.get('autoIncrement'))) props.generated = true;
  const def = columnDefault(c);
  if (def !== undefined) props.default = def;
  const remarks = c.attrs.get('remarks');
  if (remarks) props.comment = remarks;

  let fk: RawRelation | undefined;
  if (cons) {
    const ref = cons.attrs.get('references');
    const refTable = cons.attrs.get('referencedTableName');
    const refCols = cons.attrs.get('referencedColumnNames');
    let toName: string | undefined;
    let toCols: string[] = [];
    if (ref) {
      const rm = /^\s*([^\s(]+)\s*(?:\(([^)]*)\))?/.exec(ref);
      if (rm) {
        toName = rm[1];
        toCols = splitCsv(rm[2]);
      }
    } else if (refTable) {
      toName = refTable;
      toCols = splitCsv(refCols);
    }
    if (toName) {
      fk = {
        from: { name: '' }, // filled in by the caller (table name)
        fromColumns: [name],
        to: { name: toName },
        toColumns: toCols,
        cardinality: 'many-to-one',
        kind: 'foreign-key',
        ...(cons.attrs.get('foreignKeyName') ? { name: cons.attrs.get('foreignKeyName') } : {}),
        ...(truthy(cons.attrs.get('deleteCascade')) ? { onDelete: 'CASCADE' } : {}),
        source: { file, line: c.line },
      };
    }
  }
  return { col: column(name, type, props), fk };
}

function emit(changeSets: LNode[], file: string): ParseResult {
  const result: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [], ops: [] };
  const src = (line: number): SourceRef => ({ file, line });

  for (const cs of changeSets) {
    for (const change of cs.children) {
      const ref = tableRef(change);
      switch (change.name) {
        case 'createTable':
        case 'createView': {
          if (change.name === 'createView') {
            const vn = change.attrs.get('viewName');
            if (vn) {
              result.entities.push({
                name: vn,
                kind: 'view',
                ...(change.attrs.get('schemaName') ? { schema: change.attrs.get('schemaName') } : {}),
                nameCertainty: 2,
                columns: [],
                source: src(change.line),
              });
            }
            break;
          }
          if (!ref) break;
          const entity: RawEntity = {
            name: ref.name,
            kind: 'table',
            ...(ref.schema ? { schema: ref.schema } : {}),
            nameCertainty: 2,
            columns: [],
            source: src(change.line),
          };
          for (const c of children(change, 'column')) {
            const { col, fk } = buildColumn(c, file);
            entity.columns.push(col);
            if (fk) {
              fk.from = { name: ref.name, ...(ref.schema ? { schema: ref.schema } : {}) };
              result.relations.push(fk);
            }
          }
          result.entities.push(entity);
          break;
        }

        case 'addColumn': {
          if (!ref) break;
          const entity: RawEntity = {
            name: ref.name,
            kind: 'table',
            ...(ref.schema ? { schema: ref.schema } : {}),
            partial: true,
            columns: [],
            source: src(change.line),
          };
          for (const c of children(change, 'column')) {
            const { col, fk } = buildColumn(c, file);
            entity.columns.push(col);
            if (fk) {
              fk.from = { name: ref.name, ...(ref.schema ? { schema: ref.schema } : {}) };
              result.relations.push(fk);
            }
          }
          if (entity.columns.length) result.entities.push(entity);
          break;
        }

        case 'dropColumn': {
          if (!ref) break;
          const cols = children(change, 'column').map((c) => c.attrs.get('name')).filter((x): x is string => !!x);
          const single = change.attrs.get('columnName');
          for (const name of single ? [single, ...cols] : cols) {
            result.ops!.push({ op: 'dropColumn', table: ref, column: name, source: src(change.line) });
          }
          break;
        }

        case 'renameColumn': {
          if (!ref) break;
          const from = change.attrs.get('oldColumnName');
          const to = change.attrs.get('newColumnName');
          if (from && to) result.ops!.push({ op: 'renameColumn', table: ref, column: from, to, source: src(change.line) });
          break;
        }

        case 'renameTable': {
          const oldName = change.attrs.get('oldTableName');
          const to = change.attrs.get('newTableName');
          if (oldName && to) {
            const schema = change.attrs.get('schemaName');
            result.ops!.push({ op: 'renameTable', table: { name: oldName, ...(schema ? { schema } : {}) }, to, source: src(change.line) });
          }
          break;
        }

        case 'dropTable': {
          if (ref) result.ops!.push({ op: 'dropTable', table: ref, source: src(change.line) });
          break;
        }

        case 'addForeignKeyConstraint': {
          const baseTable = change.attrs.get('baseTableName');
          const refTable = change.attrs.get('referencedTableName');
          if (!baseTable || !refTable) break;
          result.relations.push({
            from: { name: baseTable, ...(change.attrs.get('baseTableSchemaName') ? { schema: change.attrs.get('baseTableSchemaName') } : {}) },
            fromColumns: splitCsv(change.attrs.get('baseColumnNames')),
            to: { name: refTable, ...(change.attrs.get('referencedTableSchemaName') ? { schema: change.attrs.get('referencedTableSchemaName') } : {}) },
            toColumns: splitCsv(change.attrs.get('referencedColumnNames')),
            cardinality: 'many-to-one',
            kind: 'foreign-key',
            ...(change.attrs.get('constraintName') ? { name: change.attrs.get('constraintName') } : {}),
            ...(change.attrs.get('onDelete') ? { onDelete: change.attrs.get('onDelete')!.toUpperCase() } : {}),
            ...(change.attrs.get('onUpdate') ? { onUpdate: change.attrs.get('onUpdate')!.toUpperCase() } : {}),
            source: src(change.line),
          });
          break;
        }

        case 'dropForeignKeyConstraint': {
          const baseTable = change.attrs.get('baseTableName');
          if (baseTable) {
            result.ops!.push({
              op: 'dropForeignKey',
              table: { name: baseTable },
              ...(change.attrs.get('constraintName') ? { name: change.attrs.get('constraintName') } : {}),
              source: src(change.line),
            });
          }
          break;
        }

        case 'addPrimaryKey': {
          if (!ref) break;
          for (const col of splitCsv(change.attrs.get('columnNames'))) {
            result.ops!.push({ op: 'alterColumn', table: ref, column: col, set: { primaryKey: true }, source: src(change.line) });
          }
          break;
        }

        case 'addNotNullConstraint': {
          if (!ref) break;
          const col = change.attrs.get('columnName');
          if (col) {
            const dataType = normType(change.attrs.get('columnDataType'));
            result.ops!.push({ op: 'alterColumn', table: ref, column: col, set: { nullable: false, ...(dataType ? { type: dataType } : {}) }, source: src(change.line) });
          }
          break;
        }

        case 'dropNotNullConstraint': {
          if (!ref) break;
          const col = change.attrs.get('columnName');
          if (col) result.ops!.push({ op: 'alterColumn', table: ref, column: col, set: { nullable: true }, source: src(change.line) });
          break;
        }

        case 'modifyDataType': {
          if (!ref) break;
          const col = change.attrs.get('columnName');
          const type = normType(change.attrs.get('newDataType'));
          if (col && type) result.ops!.push({ op: 'alterColumn', table: ref, column: col, set: { type }, source: src(change.line) });
          break;
        }

        case 'addDefaultValue': {
          if (!ref) break;
          const col = change.attrs.get('columnName');
          const def = columnDefault(change);
          if (col && def !== undefined) result.ops!.push({ op: 'alterColumn', table: ref, column: col, set: { default: def }, source: src(change.line) });
          break;
        }

        case 'addUniqueConstraint': {
          if (!ref) break;
          const cols = splitCsv(change.attrs.get('columnNames'));
          if (cols.length) {
            result.entities.push({
              name: ref.name,
              kind: 'table',
              ...(ref.schema ? { schema: ref.schema } : {}),
              partial: true,
              columns: [],
              indexes: [{ columns: cols, unique: true, ...(change.attrs.get('constraintName') ? { name: change.attrs.get('constraintName') } : {}), source: src(change.line) }],
              source: src(change.line),
            });
          }
          break;
        }

        case 'createIndex': {
          if (!ref) break;
          const cols = children(change, 'column').map((c) => c.attrs.get('name')).filter((x): x is string => !!x);
          if (cols.length) {
            result.entities.push({
              name: ref.name,
              kind: 'table',
              ...(ref.schema ? { schema: ref.schema } : {}),
              partial: true,
              columns: [],
              indexes: [{ columns: cols, unique: truthy(change.attrs.get('unique')), ...(change.attrs.get('indexName') ? { name: change.attrs.get('indexName') } : {}), source: src(change.line) }],
              source: src(change.line),
            });
          }
          break;
        }

        default:
          break;
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parse(file: SourceFile): ParseResult {
  const ext = extOf(file.path);
  const empty: ParseResult = { origin: 'migration', entities: [], relations: [], enums: [], ops: [] };
  // `result.ops` is used with `!` in the emitter, so start it non-undefined there.
  try {
    if (ext === '.xml') {
      const nodes = parseXml(file.text);
      const dcl = findDatabaseChangeLog(nodes);
      const changeSets = dcl ? children(dcl, 'changeSet') : [];
      const result = emit(changeSets, file.path);
      result.ops = result.ops ?? [];
      return result;
    }
    if (ext === '.json') {
      let jval: JVal;
      try {
        jval = JSON.parse(file.text) as JVal;
      } catch {
        return empty;
      }
      const finder = new LineFinder(file.text);
      const changeSets = changeSetsFromJVal(jval, finder, true);
      const result = emit(changeSets, file.path);
      result.ops = result.ops ?? [];
      return result;
    }
    // .yaml / .yml
    const jval = parseYaml(file.text);
    const finder = new LineFinder(file.text);
    const changeSets = changeSetsFromJVal(jval, finder, false);
    const result = emit(changeSets, file.path);
    result.ops = result.ops ?? [];
    return result;
  } catch {
    return empty;
  }
}

function findDatabaseChangeLog(nodes: LNode[]): LNode | undefined {
  for (const n of nodes) if (n.name === 'databaseChangeLog') return n;
  return nodes.length ? nodes[0] : undefined;
}

export const liquibaseParser: SchemaParser = {
  kind: 'liquibase',
  extensions: ['.xml', '.yaml', '.yml', '.json'],
  filePatterns: [
    '**/*changelog*.{xml,yaml,yml,json}',
    '**/db/changelog/**/*.{xml,yaml,yml,json}',
    '**/liquibase/**/*.{xml,yaml,yml,json}',
  ],
  detect,
  parse,
};
