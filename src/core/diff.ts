/**
 * Schema diff: compares two resolved `SchemaModel`s (e.g. a git ref against the working tree).
 * Pure functions on plain data - no Node or VS Code APIs - shared by the host and the webview.
 */

import { qualifiedName } from './format';
import type { Column, EntityKind, EnumDef, Relation, SchemaModel } from './model';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface ColumnChange {
  name: string;
  kind: ChangeKind;
  before?: Column;
  after?: Column;
  /** Human readable attribute changes of a `changed` column, e.g. `type: int -> bigint`. */
  changes: string[];
}

export interface EntityChange {
  id: string;
  /** Display name (schema-qualified). */
  name: string;
  kind: ChangeKind;
  entityKind: EntityKind;
  /** Added / removed entities list all their columns; changed ones list only the differing columns. */
  columns: ColumnChange[];
  unchangedColumns: number;
  indexesAdded: string[];
  indexesRemoved: string[];
  /** `table -> view` style note when the entity kind changed. */
  kindChange?: string;
}

export interface RelationChange {
  /** Stable key: `from(cols)->to`. */
  key: string;
  kind: ChangeKind;
  /** Display text, e.g. `posts(author_id) -> users(id)`. */
  label: string;
  cardinality: string;
  changes: string[];
}

export interface EnumChange {
  id: string;
  name: string;
  kind: ChangeKind;
  valuesAdded: string[];
  valuesRemoved: string[];
}

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface DiffSummary {
  entities: DiffCounts;
  columns: DiffCounts;
  relations: DiffCounts;
  enums: DiffCounts;
  /** Total number of differences. */
  total: number;
}

export interface SchemaDiff {
  entities: EntityChange[];
  relations: RelationChange[];
  enums: EnumChange[];
  summary: DiffSummary;
}

const ORDER: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };

const byKindThenName = <T extends { kind: ChangeKind; name: string }>(a: T, b: T): number =>
  ORDER[a.kind] - ORDER[b.kind] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function describeColumnChanges(a: Column, b: Column): string[] {
  const out: string[] = [];
  if (a.type.toLowerCase() !== b.type.toLowerCase()) out.push(`type: ${a.type || '?'} -> ${b.type || '?'}`);
  if (a.nullable !== b.nullable) out.push(b.nullable ? 'now nullable' : 'now NOT NULL');
  if (a.primaryKey !== b.primaryKey) out.push(b.primaryKey ? 'now primary key' : 'no longer primary key');
  if (a.unique !== b.unique) out.push(b.unique ? 'now unique' : 'no longer unique');
  if (!!a.generated !== !!b.generated) out.push(b.generated ? 'now generated' : 'no longer generated');
  if (!!a.isArray !== !!b.isArray) out.push(b.isArray ? 'now an array' : 'no longer an array');
  if ((a.default ?? '') !== (b.default ?? '')) out.push(`default: ${a.default ?? '(none)'} -> ${b.default ?? '(none)'}`);
  if ((a.comment ?? '') !== (b.comment ?? '')) out.push('comment changed');
  return out;
}

function indexSignature(i: { columns: string[]; unique: boolean }): string {
  return `${i.unique ? 'unique ' : ''}(${i.columns.join(', ')})`;
}

function diffEntities(base: SchemaModel, head: SchemaModel): EntityChange[] {
  const before = new Map(base.entities.map((e) => [e.id, e]));
  const after = new Map(head.entities.map((e) => [e.id, e]));
  const out: EntityChange[] = [];

  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) {
      out.push({
        id,
        name: qualifiedName(e),
        kind: 'added',
        entityKind: e.kind,
        columns: e.columns.map((c) => ({ name: c.name, kind: 'added', after: c, changes: [] })),
        unchangedColumns: 0,
        indexesAdded: e.indexes.map(indexSignature),
        indexesRemoved: [],
      });
      continue;
    }
    const oldCols = new Map(old.columns.map((c) => [c.name.toLowerCase(), c]));
    const newCols = new Map(e.columns.map((c) => [c.name.toLowerCase(), c]));
    const columns: ColumnChange[] = [];
    let unchanged = 0;
    for (const [key, c] of newCols) {
      const o = oldCols.get(key);
      if (!o) {
        columns.push({ name: c.name, kind: 'added', after: c, changes: [] });
        continue;
      }
      const changes = describeColumnChanges(o, c);
      if (changes.length) columns.push({ name: c.name, kind: 'changed', before: o, after: c, changes });
      else unchanged++;
    }
    for (const [key, o] of oldCols) if (!newCols.has(key)) columns.push({ name: o.name, kind: 'removed', before: o, changes: [] });

    const oldIdx = new Set(old.indexes.map(indexSignature));
    const newIdx = new Set(e.indexes.map(indexSignature));
    const indexesAdded = [...newIdx].filter((s) => !oldIdx.has(s)).sort();
    const indexesRemoved = [...oldIdx].filter((s) => !newIdx.has(s)).sort();
    const kindChange = old.kind !== e.kind ? `${old.kind} -> ${e.kind}` : undefined;

    if (columns.length || indexesAdded.length || indexesRemoved.length || kindChange) {
      out.push({
        id,
        name: qualifiedName(e),
        kind: 'changed',
        entityKind: e.kind,
        columns,
        unchangedColumns: unchanged,
        indexesAdded,
        indexesRemoved,
        ...(kindChange ? { kindChange } : {}),
      });
    }
  }
  for (const [id, e] of before) {
    if (after.has(id)) continue;
    out.push({
      id,
      name: qualifiedName(e),
      kind: 'removed',
      entityKind: e.kind,
      columns: e.columns.map((c) => ({ name: c.name, kind: 'removed', before: c, changes: [] })),
      unchangedColumns: 0,
      indexesAdded: [],
      indexesRemoved: e.indexes.map(indexSignature),
    });
  }
  return out.sort(byKindThenName);
}

function relationKey(r: Relation): string {
  const cols = [...r.fromColumns].sort().join(',');
  return `${r.from}(${cols})->${r.to}`;
}

function relationLabel(r: Relation, names: Map<string, string>): string {
  const n = (id: string) => names.get(id) ?? id;
  const to = r.toColumns.length ? `(${r.toColumns.join(', ')})` : '';
  return `${n(r.from)}(${r.fromColumns.join(', ')}) -> ${n(r.to)}${to}`;
}

function describeRelationChanges(a: Relation, b: Relation): string[] {
  const out: string[] = [];
  if (a.cardinality !== b.cardinality) out.push(`cardinality: ${a.cardinality} -> ${b.cardinality}`);
  if (a.toColumns.join(',') !== b.toColumns.join(',')) out.push(`references: (${a.toColumns.join(', ')}) -> (${b.toColumns.join(', ')})`);
  if (a.optional !== b.optional) out.push(b.optional ? 'now optional' : 'now required');
  if ((a.onDelete ?? '').toLowerCase() !== (b.onDelete ?? '').toLowerCase()) out.push(`on delete: ${a.onDelete ?? '(none)'} -> ${b.onDelete ?? '(none)'}`);
  if ((a.onUpdate ?? '').toLowerCase() !== (b.onUpdate ?? '').toLowerCase()) out.push(`on update: ${a.onUpdate ?? '(none)'} -> ${b.onUpdate ?? '(none)'}`);
  return out;
}

function diffRelations(base: SchemaModel, head: SchemaModel): RelationChange[] {
  const names = new Map<string, string>();
  for (const e of [...base.entities, ...head.entities]) names.set(e.id, qualifiedName(e));
  const before = new Map(base.relations.map((r) => [relationKey(r), r]));
  const after = new Map(head.relations.map((r) => [relationKey(r), r]));
  const out: (RelationChange & { name: string })[] = [];
  for (const [key, r] of after) {
    const o = before.get(key);
    if (!o) out.push({ key, name: relationLabel(r, names), kind: 'added', label: relationLabel(r, names), cardinality: r.cardinality, changes: [] });
    else {
      const changes = describeRelationChanges(o, r);
      if (changes.length) out.push({ key, name: relationLabel(r, names), kind: 'changed', label: relationLabel(r, names), cardinality: r.cardinality, changes });
    }
  }
  for (const [key, r] of before) {
    if (!after.has(key)) out.push({ key, name: relationLabel(r, names), kind: 'removed', label: relationLabel(r, names), cardinality: r.cardinality, changes: [] });
  }
  return out.sort(byKindThenName).map(({ name: _name, ...rest }) => rest);
}

function enumName(e: EnumDef): string {
  return e.schema ? `${e.schema}.${e.name}` : e.name;
}

function diffEnums(base: SchemaModel, head: SchemaModel): EnumChange[] {
  const before = new Map(base.enums.map((e) => [e.id, e]));
  const after = new Map(head.enums.map((e) => [e.id, e]));
  const out: EnumChange[] = [];
  for (const [id, e] of after) {
    const o = before.get(id);
    if (!o) {
      out.push({ id, name: enumName(e), kind: 'added', valuesAdded: [...e.values], valuesRemoved: [] });
      continue;
    }
    const oldV = new Set(o.values);
    const newV = new Set(e.values);
    const valuesAdded = e.values.filter((v) => !oldV.has(v));
    const valuesRemoved = o.values.filter((v) => !newV.has(v));
    if (valuesAdded.length || valuesRemoved.length) out.push({ id, name: enumName(e), kind: 'changed', valuesAdded, valuesRemoved });
  }
  for (const [id, e] of before) {
    if (!after.has(id)) out.push({ id, name: enumName(e), kind: 'removed', valuesAdded: [], valuesRemoved: [...e.values] });
  }
  return out.sort(byKindThenName);
}

function count(items: readonly { kind: ChangeKind }[]): DiffCounts {
  const c: DiffCounts = { added: 0, removed: 0, changed: 0 };
  for (const i of items) c[i.kind]++;
  return c;
}

/** Computes what changed going from `base` to `head`. */
export function diffSchemas(base: SchemaModel, head: SchemaModel): SchemaDiff {
  const entities = diffEntities(base, head);
  const relations = diffRelations(base, head);
  const enums = diffEnums(base, head);
  // Column counts only cover entities present on both sides; whole-table adds / removes are counted as entities.
  const columns = count(entities.filter((e) => e.kind === 'changed').flatMap((e) => e.columns));
  const sum = (c: DiffCounts) => c.added + c.removed + c.changed;
  const ec = count(entities);
  const rc = count(relations);
  const nc = count(enums);
  return { entities, relations, enums, summary: { entities: ec, columns, relations: rc, enums: nc, total: sum(ec) + sum(columns) + sum(rc) + sum(nc) } };
}

export function isEmptyDiff(diff: SchemaDiff): boolean {
  return diff.summary.total === 0;
}

/** One-line summary, e.g. `2 tables added, 1 column changed, 1 relation removed`. */
export function diffSummaryText(diff: SchemaDiff): string {
  if (isEmptyDiff(diff)) return 'No schema changes';
  const s = diff.summary;
  const parts: string[] = [];
  const add = (c: DiffCounts, one: string, many: string) => {
    for (const k of ['added', 'removed', 'changed'] as const) if (c[k]) parts.push(`${c[k]} ${c[k] === 1 ? one : many} ${k}`);
  };
  add(s.entities, 'table', 'tables');
  add(s.columns, 'column', 'columns');
  add(s.relations, 'relation', 'relations');
  add(s.enums, 'enum', 'enums');
  return parts.join(', ');
}

const MARK: Record<ChangeKind, string> = { added: '+', removed: '-', changed: '~' };

function columnLine(c: ColumnChange): string {
  const col = c.after ?? c.before!;
  const type = col.type ? ` \`${col.type}\`` : '';
  const detail = c.kind === 'changed' ? `: ${c.changes.join('; ')}` : '';
  return `- ${MARK[c.kind]} \`${c.name}\`${c.kind === 'changed' ? '' : type}${detail}`;
}

/** Markdown changelog of a diff. */
export function diffToMarkdown(diff: SchemaDiff, labels: { base: string; head: string }): string {
  const lines: string[] = [`# Schema changes: ${labels.base} -> ${labels.head}`, '', `**${diffSummaryText(diff)}**`, ''];
  if (isEmptyDiff(diff)) return lines.join('\n').trimEnd() + '\n';

  const kinds: { kind: ChangeKind; title: string }[] = [
    { kind: 'added', title: 'Added' },
    { kind: 'changed', title: 'Changed' },
    { kind: 'removed', title: 'Removed' },
  ];
  for (const { kind, title } of kinds) {
    const entities = diff.entities.filter((e) => e.kind === kind);
    const relations = diff.relations.filter((r) => r.kind === kind);
    const enums = diff.enums.filter((e) => e.kind === kind);
    if (!entities.length && !relations.length && !enums.length) continue;
    lines.push(`## ${title}`, '');
    if (entities.length) {
      lines.push('### Tables', '');
      for (const e of entities) {
        lines.push(`#### ${e.name}${e.kindChange ? ` (${e.kindChange})` : ''}`, '');
        for (const c of e.columns) lines.push(columnLine(c));
        for (const i of e.indexesAdded) lines.push(`- + index ${i}`);
        for (const i of e.indexesRemoved) lines.push(`- - index ${i}`);
        lines.push('');
      }
    }
    if (relations.length) {
      lines.push('### Relations', '');
      for (const r of relations) lines.push(`- ${r.label} (${r.cardinality})${r.changes.length ? `: ${r.changes.join('; ')}` : ''}`);
      lines.push('');
    }
    if (enums.length) {
      lines.push('### Enums', '');
      for (const e of enums) {
        const parts: string[] = [];
        if (e.valuesAdded.length) parts.push(`+ ${e.valuesAdded.join(', ')}`);
        if (e.valuesRemoved.length) parts.push(`- ${e.valuesRemoved.join(', ')}`);
        lines.push(`- \`${e.name}\`${parts.length ? `: ${parts.join('; ')}` : ''}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
