/**
 * GraphQL SDL parser (`.graphql`, `.gql`, `.graphqls`). A GraphQL schema describes an API, not a
 * database, so object types become entities ONLY when they carry a database / ORM directive at type
 * level (`@model`, `@entity`, `@table`, `@node`, `@db`, `@dbTable`, `@sqlTable`, `@collection`,
 * `@dgraph`). Files without such a directive are skipped entirely (no false positives).
 *
 * Fields: scalar fields become columns (`ID!` / `@id` = primary key, `!` = not null, `[T]` = array,
 * `@column(name:)` / `@db(name:)` / `@map(name:)` rename), fields of another entity type become
 * many-to-one relations (list fields only when `@hasMany` is present and the target has no back
 * reference). Enum types of such files are emitted as enums.
 */

import type { Column, ParseResult, RawEntity, RawEnum, RawRelation, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, lcfirst } from '../core/naming';

const DB_DIRECTIVES = new Set(['model', 'entity', 'table', 'node', 'db', 'dbtable', 'sqltable', 'collection', 'dgraph']);
const SKIP_TYPES = new Set(['Query', 'Mutation', 'Subscription']);
const RENAME_DIRECTIVES = new Set(['column', 'db', 'map', 'dbfield']);
const PK_DIRECTIVES = new Set(['id', 'primarykey', 'unique_id']);
const TYPE_RE = /\b(?:extend\s+)?(?:type|interface)\s+([A-Za-z_]\w*)([^{]{0,600}?)\{/g;

function detect(file: SourceFile): boolean {
  return /@(model|entity|table|node|db|dbTable|sqlTable|collection|dgraph)\b/.test(file.text) && /\b(type|interface)\s+[A-Za-z_]/.test(file.text);
}

/** Blanks comments and strings (keeping offsets and newlines) so structure can be scanned safely. */
function mask(t: string): string {
  const out = t.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  const n = t.length;
  while (i < n) {
    const ch = t[i];
    if (ch === '#') {
      let e = t.indexOf('\n', i);
      if (e < 0) e = n;
      blank(i, e);
      i = e;
    } else if (t.startsWith('"""', i)) {
      let e = t.indexOf('"""', i + 3);
      e = e < 0 ? n : e + 3;
      blank(i, e);
      i = e;
    } else if (ch === '"') {
      let e = i + 1;
      while (e < n && t[e] !== '"' && t[e] !== '\n') e += t[e] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(e, n));
      i = e + 1;
    } else i++;
  }
  return out.join('');
}

interface Directive {
  name: string;
  args: string;
}

function directives(masked: string, original: string, from: number, to: number): Directive[] {
  const out: Directive[] = [];
  const re = /@([A-Za-z_]\w*)/g;
  const seg = masked.slice(from, to);
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) {
    let args = '';
    let p = m.index + m[0].length;
    while (p < seg.length && /\s/.test(seg[p])) p++;
    if (seg[p] === '(') {
      let depth = 0;
      let q = p;
      for (; q < seg.length; q++) {
        if (seg[q] === '(') depth++;
        else if (seg[q] === ')' && --depth === 0) break;
      }
      args = original.slice(from + p + 1, from + q);
      re.lastIndex = q;
    }
    out.push({ name: m[1], args });
  }
  return out;
}

function arg(d: Directive | undefined, ...names: string[]): string | undefined {
  if (!d) return undefined;
  for (const n of names) {
    const m = new RegExp(`\\b${n}\\s*:\\s*"([^"]*)"`).exec(d.args);
    if (m) return m[1];
  }
  return undefined;
}

interface TypeDef {
  name: string;
  line: number;
  dirs: Directive[];
  bodyStart: number;
  bodyEnd: number;
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const text = file.text;
  const masked = mask(text);
  // Precomputed line starts keep line lookup logarithmic on big files.
  const starts: number[] = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (off: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const types: TypeDef[] = [];
  TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPE_RE.exec(masked))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = masked.length;
    for (let i = open; i < masked.length; i++) {
      const c = masked[i];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    TYPE_RE.lastIndex = Math.min(close + 1, masked.length);
    const hdrStart = m.index + m[0].indexOf(m[1]) + m[1].length;
    types.push({ name: m[1], line: lineAt(m.index), dirs: directives(masked, text, hdrStart, open), bodyStart: open + 1, bodyEnd: close });
  }

  const entityTypes = types.filter((t) => !SKIP_TYPES.has(t.name) && t.dirs.some((d) => DB_DIRECTIVES.has(d.name.toLowerCase())));
  if (!entityTypes.length) return result;
  const entityNames = new Set(entityTypes.map((t) => t.name));

  // Fields of every entity first (needed for back-reference checks).
  const parsed = entityTypes.map((t) => ({ t, fields: fieldsOf(masked, text, t, lineAt) }));
  const hasBackRef = (target: string, owner: string): boolean =>
    parsed.some((p) => p.t.name === target && p.fields.some((f) => f.base === owner && !f.list));

  for (const { t, fields } of parsed) {
    const dbDir = t.dirs.find((d) => DB_DIRECTIVES.has(d.name.toLowerCase()));
    const explicit = t.dirs.filter((d) => DB_DIRECTIVES.has(d.name.toLowerCase())).map((d) => arg(d, 'name', 'table', 'tableName', 'collection', 'type')).find(Boolean);
    const entity: RawEntity = {
      name: explicit ?? defaultTableName('prisma', t.name),
      kind: dbDir && dbDir.name.toLowerCase() === 'collection' ? 'collection' : 'table',
      modelName: t.name,
      nameCertainty: explicit ? 2 : 0,
      columns: [],
      source: sourceRef(file, t.line),
    };
    const self = { name: entity.name, model: t.name };
    for (const f of fields) {
      const dirNames = f.dirs.map((d) => d.name.toLowerCase());
      if (entityNames.has(f.base)) {
        const hasMany = dirNames.includes('hasmany');
        if (f.list && !(hasMany && !hasBackRef(f.base, t.name))) continue;
        const cols = f.list ? [`${lcfirst(t.name)}Id`] : [arg(f.dirs.find((d) => d.name === 'belongsTo' || d.name === 'hasOne'), 'fields') ?? `${f.name}Id`];
        const rel: RawRelation = {
          from: f.list ? { model: f.base } : self,
          fromColumns: cols,
          to: f.list ? self : { model: f.base },
          toColumns: [],
          cardinality: dirNames.includes('hasone') ? 'one-to-one' : 'many-to-one',
          kind: 'orm',
          optional: !f.required,
          navigation: f.name,
          source: sourceRef(file, f.line),
        };
        result.relations.push(rel);
        continue;
      }
      if (f.args) continue; // computed / resolver fields take arguments
      const rename = f.dirs.find((d) => RENAME_DIRECTIVES.has(d.name.toLowerCase()));
      const pk = f.base === 'ID' || dirNames.some((d) => PK_DIRECTIVES.has(d));
      const col: Column = column(arg(rename, 'name', 'column') ?? f.name, f.base, {
        nullable: !f.required && !pk,
        primaryKey: pk,
        unique: dirNames.includes('unique'),
        source: sourceRef(file, f.line),
      });
      if (f.list) col.isArray = true;
      if (f.base === 'ID' && f.required) col.generated = true;
      entity.columns.push(col);
    }
    result.entities.push(entity);
  }

  // Enums of the file.
  const enumRe = /\benum\s+([A-Za-z_]\w*)[^{]{0,200}\{/g;
  while ((m = enumRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = masked.indexOf('}', open);
    const values = (close < 0 ? masked.slice(open + 1) : masked.slice(open + 1, close))
      .split(/[\s,]+/)
      .filter((v) => /^[A-Za-z_]\w*$/.test(v));
    if (values.length) {
      const en: RawEnum = { name: m[1], values, source: sourceRef(file, lineAt(m.index)) };
      result.enums.push(en);
    }
    enumRe.lastIndex = open + 1;
  }
  return result;
}

interface Field {
  name: string;
  base: string;
  list: boolean;
  required: boolean;
  args: boolean;
  line: number;
  dirs: Directive[];
}

const FIELD_RE = /^[ \t,]*([A-Za-z_]\w*)[ \t]*(\([^)]*\))?[ \t]*:[ \t]*(\[?)[ \t]*([A-Za-z_]\w*)[ \t]*(!?)[ \t]*(\]?)[ \t]*(!?)(.*)$/;

function fieldsOf(masked: string, original: string, t: TypeDef, lineAt: (o: number) => number): Field[] {
  const out: Field[] = [];
  let pos = t.bodyStart;
  while (pos < t.bodyEnd) {
    let eol = masked.indexOf('\n', pos);
    if (eol < 0 || eol > t.bodyEnd) eol = t.bodyEnd;
    const line = masked.slice(pos, eol).replace(/\r$/, '');
    const m = FIELD_RE.exec(line);
    if (m) {
      const list = m[3] === '[';
      out.push({
        name: m[1],
        base: m[4],
        list,
        required: list ? m[7] === '!' : m[5] === '!',
        args: !!m[2],
        line: lineAt(pos),
        dirs: directives(masked, original, pos, eol),
      });
    }
    pos = eol + 1;
  }
  return out;
}

export const graphqlParser: SchemaParser = {
  kind: 'graphql',
  extensions: ['.graphql', '.gql', '.graphqls'],
  detect,
  parse,
};
