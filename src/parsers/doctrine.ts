/**
 * Doctrine (PHP) parser.
 *
 * Reads mapping metadata declared either as PHP 8 attributes (`#[ORM\Entity]`, `#[ORM\Column(...)]`)
 * or as docblock annotations (`/** @ORM\Entity *\/`, `@ORM\Column(type="string")`). Attributes live
 * in code, annotations live in comments, so both views of the file are mined and merged into a
 * single uniform metadata model.
 *
 * Laravel also uses `.php`; `detect` only claims files carrying Doctrine mapping markers.
 */

import type {
  Column,
  EntityRef,
  IndexDef,
  ParseResult,
  RawEntity,
  RawRelation,
  SourceFile,
  SourceRef,
} from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { defaultTableName, shortName, snakeCase } from '../core/naming';
import { Code, boolValue, stringValue } from '../core/text';
import { splitArgs } from './shared/rubyphp';

function detect(file: SourceFile): boolean {
  const t = file.text;
  return /\bDoctrine\\ORM\\Mapping\b/.test(t) || /@ORM\\/.test(t) || /#\[\s*ORM\\/.test(t);
}

interface Meta {
  tag: string;
  named: Map<string, string>;
  positional: string[];
  at: number;
}

type MemberKind = 'class' | 'prop' | 'method';
interface Member {
  kind: MemberKind;
  name: string;
  base?: string;
  type?: string;
  at: number;
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'php');
  const metas = collectMetas(code);
  const members = collectMembers(code);
  const byMember = assignMetas(metas, members);

  // Pre-pass: which classes are single-table inheritance roots (children share their table).
  const stiBases = new Set<string>();
  for (const mb of members) {
    if (mb.kind !== 'class') continue;
    const ms = byMember.get(mb) ?? [];
    if (ms.some((m) => m.tag === 'InheritanceType' && /SINGLE_TABLE/.test(m.positional[0] ?? ''))) stiBases.add(mb.name);
  }

  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  let current: { entity: RawEntity; table: string } | undefined;

  for (const mb of members) {
    const ms = byMember.get(mb) ?? [];
    if (mb.kind === 'class') {
      current = startClass(mb, ms, file, code, stiBases);
      if (current) entities.push(current.entity);
    } else if (mb.kind === 'prop' && current) {
      processProperty(mb, ms, current, relations, file, code);
    }
  }

  return { entities, relations, enums: [] };
}

// ── metadata collection ─────────────────────────────────────────────────────────────────────

function collectMetas(code: Code): Meta[] {
  const metas: Meta[] = [];
  const m = code.masked;

  // Attributes: `#[ORM\Tag(...)]` – they are code.
  for (const am of m.matchAll(/ORM\\(\w+)/g)) {
    const at = am.index!;
    if (!code.isCode(at)) continue;
    const tag = am[1];
    let i = at + am[0].length;
    while (i < m.length && (m[i] === ' ' || m[i] === '\t')) i++;
    const named = new Map<string, string>();
    let positional: string[] = [];
    if (m[i] === '(') {
      const a = code.args(i);
      for (const [k, v] of a.named) named.set(k, v.text);
      positional = a.positional.map((p) => p.text);
    }
    metas.push({ tag, named, positional, at });
  }

  // Annotations: `@ORM\Tag(...)` inside docblocks.
  for (const am of code.text.matchAll(/@ORM\\(\w+)/g)) {
    const at = am.index!;
    if (!code.inComment(at)) continue;
    const tag = am[1];
    const commentEnd = code.text.indexOf('*/', at);
    const win = code.text.slice(at + am[0].length, Math.min(commentEnd < 0 ? code.text.length : commentEnd, at + 1000));
    const seg = win.replace(/\n[ \t]*\*?[ \t]*/g, ' ');
    const { positional, named } = annotationArgs(seg);
    metas.push({ tag, named, positional, at });
  }

  return metas.sort((a, b) => a.at - b.at);
}

function annotationArgs(seg: string): { positional: string[]; named: Map<string, string> } {
  const named = new Map<string, string>();
  const positional: string[] = [];
  const open = /^\s*\(/.exec(seg);
  if (!open) return { positional, named };
  const start = seg.indexOf('(');
  let depth = 0;
  let close = -1;
  let q: string | null = null;
  for (let i = start; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === ')') {
        close = i;
        break;
      }
    }
  }
  const inner = seg.slice(start + 1, close < 0 ? seg.length : close);
  for (const part of splitArgs(inner)) {
    const km = /^(\w+)\s*=\s*([\s\S]*)$/.exec(part);
    if (km) named.set(km[1], km[2].trim());
    else if (part) positional.push(part);
  }
  return { positional, named };
}

function collectMembers(code: Code): Member[] {
  const m = code.masked;
  const members: Member[] = [];
  for (const cm of m.matchAll(/\bclass\s+(\w+)(?:\s+extends\s+([\\\w]+))?/g)) {
    members.push({ kind: 'class', name: cm[1], base: cm[2] ? shortName(cm[2]) : undefined, at: cm.index! });
  }
  for (const pm of m.matchAll(/^[ \t]*(?:private|protected|public)(?:\s+readonly)?(?:\s+static)?\s+(?:(\??[\\\w|]+)\s+)?\$(\w+)/gm)) {
    const ws = pm[0].length - pm[0].trimStart().length;
    members.push({ kind: 'prop', name: pm[2], type: pm[1], at: pm.index! + ws });
  }
  for (const fm of m.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    members.push({ kind: 'method', name: fm[1], at: fm.index! });
  }
  return members.sort((a, b) => a.at - b.at);
}

/** Each meta belongs to the first member that starts after it. */
function assignMetas(metas: Meta[], members: Member[]): Map<Member, Meta[]> {
  const byMember = new Map<Member, Meta[]>();
  // `metas` and `members` are both sorted by `at`, so a single forward cursor assigns each meta to
  // the first member that starts after it in O(n) – `members.find(...)` per meta was O(metas × members),
  // which made large single-file entity catalogues (~0.7 MB → 1.5 s) scale quadratically.
  let mi = 0;
  for (const meta of metas) {
    while (mi < members.length && members[mi].at <= meta.at) mi++;
    if (mi >= members.length) break;
    const mb = members[mi];
    const list = byMember.get(mb);
    if (list) list.push(meta);
    else byMember.set(mb, [meta]);
  }
  return byMember;
}

// ── class / property processing ─────────────────────────────────────────────────────────────

function metaStr(meta: Meta | undefined, key: string): string | undefined {
  return meta ? stringValue(meta.named.get(key)) : undefined;
}

function startClass(
  mb: Member,
  metas: Meta[],
  file: SourceFile,
  code: Code,
  stiBases: Set<string>,
): { entity: RawEntity; table: string } | undefined {
  const isEntity = metas.some((m) => m.tag === 'Entity');
  const isSuper = metas.some((m) => m.tag === 'MappedSuperclass');
  if (metas.some((m) => m.tag === 'Embeddable')) return undefined;
  if (!isEntity && !isSuper) return undefined;

  const tableMeta = metas.find((m) => m.tag === 'Table');
  const explicit = metaStr(tableMeta, 'name');
  const table = explicit ?? defaultTableName('doctrine', mb.name);
  const schema = metaStr(tableMeta, 'schema');

  const entity: RawEntity = {
    name: table,
    kind: 'table',
    modelName: mb.name,
    nameCertainty: explicit ? 2 : 0,
    columns: [],
    source: sourceRef(file, code.lineAt(mb.at)),
  };
  if (schema) entity.schema = schema;
  if (isSuper) entity.abstract = true;
  if (mb.base) {
    // `extends` is a safe hint: the resolver copies columns only when the base is a mapped
    // superclass of the same kind; single-table children additionally share the base's table.
    entity.extends = [mb.base];
    if (stiBases.has(mb.base)) entity.sharedTable = true;
  }

  for (const idx of indexDefs(metas, file, code)) (entity.indexes ??= []).push(idx);
  return { entity, table };
}

function indexDefs(metas: Meta[], file: SourceFile, code: Code): IndexDef[] {
  const out: IndexDef[] = [];
  for (const m of metas) {
    if (m.tag !== 'Index' && m.tag !== 'UniqueConstraint') continue;
    const colsRaw = m.named.get('columns') ?? m.named.get('fields');
    if (!colsRaw) continue;
    const columns = listOf(colsRaw);
    if (!columns.length) continue;
    const name = stringValue(m.named.get('name'));
    out.push({ columns, unique: m.tag === 'UniqueConstraint', ...(name ? { name } : {}), source: sourceRef(file, code.lineAt(m.at)) });
  }
  return out;
}

function processProperty(mb: Member, metas: Meta[], current: { entity: RawEntity; table: string }, relations: RawRelation[], file: SourceFile, code: Code): void {
  const ref = sourceRef(file, code.lineAt(mb.at));
  const col = metas.find((m) => m.tag === 'Column');
  const id = metas.find((m) => m.tag === 'Id');
  const relMeta = metas.find((m) => ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany'].includes(m.tag));

  if (metas.some((m) => m.tag === 'Embedded')) return;

  if (relMeta) {
    processRelation(mb, metas, relMeta, current, relations, ref);
    return;
  }

  if (col || id) {
    const name = metaStr(col, 'name') ?? snakeCase(mb.name);
    const type = normalizeType(col?.named.get('type')) ?? phpType(mb.type);
    const nullable = boolValue(col?.named.get('nullable')) === true;
    const unique = boolValue(col?.named.get('unique')) === true;
    const props: Partial<Column> = { nullable, unique, source: ref };
    if (id) {
      props.primaryKey = true;
      props.nullable = false;
    }
    if (metas.some((m) => m.tag === 'GeneratedValue')) props.generated = true;
    current.entity.columns.push(column(name, type, props));
  }
}

function processRelation(
  mb: Member,
  metas: Meta[],
  relMeta: Meta,
  current: { entity: RawEntity; table: string },
  relations: RawRelation[],
  ref: SourceRef,
): void {
  const mappedBy = metaStr(relMeta, 'mappedBy');
  const target = classRef(relMeta.named.get('targetEntity')) ?? (mb.type ? phpType(mb.type) : undefined);
  if (!target || !/^[A-Za-z_]\w*$/.test(target)) return;
  const to: EntityRef = { model: target };
  const self: EntityRef = { name: current.table, model: current.entity.modelName };

  if (relMeta.tag === 'OneToMany') return; // inverse side; the owning ManyToOne defines the FK
  if (relMeta.tag === 'ManyToMany') {
    if (mappedBy) return; // inverse side
    const joinTable = metas.find((m) => m.tag === 'JoinTable');
    const name = metaStr(joinTable, 'name') ?? `${current.table}_${defaultTableName('doctrine', target)}`;
    relations.push({
      from: self,
      fromColumns: [],
      to,
      toColumns: [],
      cardinality: 'many-to-many',
      kind: 'orm',
      through: { name },
      source: ref,
    });
    return;
  }

  // ManyToOne (always owning) / OneToOne (owning when it has no mappedBy)
  if (relMeta.tag === 'OneToOne' && mappedBy) return;
  const joinColumn = metas.find((m) => m.tag === 'JoinColumn');
  const fkName = metaStr(joinColumn, 'name') ?? `${snakeCase(mb.name)}_id`;
  const refCol = metaStr(joinColumn, 'referencedColumnName');
  const nullable = boolValue(joinColumn?.named.get('nullable')) !== false; // Doctrine default: nullable
  const onDelete = metaStr(joinColumn, 'onDelete');
  current.entity.columns.push(column(fkName, '', { nullable, source: ref }));
  relations.push({
    from: self,
    fromColumns: [fkName],
    to,
    toColumns: refCol ? [refCol] : [],
    cardinality: relMeta.tag === 'OneToOne' ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    ...(onDelete ? { onDelete } : {}),
    optional: nullable,
    source: ref,
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

function normalizeType(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const s = stringValue(expr) ?? expr.trim();
  const last = s.split('::').pop() ?? s;
  const clean = last.replace(/['"]/g, '').trim().toLowerCase();
  return clean || undefined;
}

function phpType(type: string | undefined): string {
  if (!type) return '';
  return type.replace(/^\?/, '').replace(/^\\/, '');
}

function listOf(raw: string): string[] {
  const out: string[] = [];
  for (const part of splitArgs(raw.replace(/^[[{(]/, '').replace(/[\]})]$/, ''))) {
    const v = stringValue(part);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** `User::class`, `"App\\Entity\\User"`, `App\\Entity\\User::class` → `User`. */
function classRef(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  const s = stringValue(t);
  if (s !== undefined) return shortName(s);
  const m = /^([\\\w]+)::class$/.exec(t);
  return shortName(m ? m[1] : t);
}

export const doctrineParser: SchemaParser = {
  kind: 'doctrine',
  extensions: ['.php'],
  detect,
  parse,
};
