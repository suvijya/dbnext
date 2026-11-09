/**
 * Display helpers shared by the tree view, the Markdown exporter and the webview.
 * Pure functions over the resolved model; no Node / VS Code / DOM APIs.
 */

import type { Cardinality, Column, Entity, EnumDef, Provenance, Relation, SchemaModel } from './model';

/** `auth.users`, or `users` for the default schema. */
export function qualifiedName(e: Pick<Entity, 'name' | 'schema'>): string {
  return e.schema ? `${e.schema}.${e.name}` : e.name;
}

export function entityKindLabel(e: Pick<Entity, 'kind' | 'joinTable' | 'external'>): string {
  if (e.external) return 'external';
  if (e.kind === 'view') return 'view';
  if (e.kind === 'collection') return 'collection';
  return e.joinTable ? 'join table' : 'table';
}

export const CARDINALITY_LABELS: Readonly<Record<Cardinality, string>> = {
  'many-to-one': 'many-to-one',
  'one-to-one': 'one-to-one',
  'many-to-many': 'many-to-many',
};

/** Short key markers of a column: `PK`, `FK`, `UK`. */
export function columnKeys(c: Column): string[] {
  const keys: string[] = [];
  if (c.primaryKey) keys.push('PK');
  if (c.references) keys.push('FK');
  if (c.unique && !c.primaryKey) keys.push('UK');
  return keys;
}

/** Column type for display, including the array marker when the type does not show it. */
export function columnType(c: Column): string {
  const t = c.type || '';
  if (c.isArray && t && !/\[\]$|^array|<.*>$|\[$/i.test(t)) return `${t}[]`;
  return t;
}

export interface EntityRelations {
  /** Relations where the entity holds the foreign key (or is the first side of a many-to-many). */
  outgoing: Relation[];
  /** Relations pointing at the entity. */
  incoming: Relation[];
}

/** Relations indexed per entity id. Many-to-many relations are listed as outgoing on both sides. */
export function relationsByEntity(relations: readonly Relation[]): Map<string, EntityRelations> {
  const map = new Map<string, EntityRelations>();
  const get = (id: string) => {
    let v = map.get(id);
    if (!v) map.set(id, (v = { outgoing: [], incoming: [] }));
    return v;
  };
  for (const r of relations) {
    get(r.from).outgoing.push(r);
    if (r.cardinality === 'many-to-many') {
      if (r.to !== r.from) get(r.to).outgoing.push(r);
    } else {
      get(r.to).incoming.push(r);
    }
  }
  return map;
}

/** Counts shown in status bar, tree view and exports. */
export function modelCounts(model: Pick<SchemaModel, 'entities' | 'relations' | 'enums'>) {
  let tables = 0;
  let views = 0;
  let collections = 0;
  let external = 0;
  for (const e of model.entities) {
    if (e.external) external++;
    else if (e.kind === 'view') views++;
    else if (e.kind === 'collection') collections++;
    else tables++;
  }
  return {
    tables,
    views,
    collections,
    external,
    entities: tables + views + collections,
    relations: model.relations.length,
    enums: model.enums.length,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `12 tables · 3 collections · 15 relations · 2 enums`. */
export function summaryText(model: Pick<SchemaModel, 'entities' | 'relations' | 'enums'>): string {
  const c = modelCounts(model);
  const parts: string[] = [];
  if (c.tables || (!c.views && !c.collections)) parts.push(plural(c.tables, 'table'));
  if (c.views) parts.push(plural(c.views, 'view'));
  if (c.collections) parts.push(plural(c.collections, 'collection'));
  parts.push(plural(c.relations, 'relation'));
  if (c.enums) parts.push(plural(c.enums, 'enum'));
  return parts.join(' · ');
}

/** Human description of a relation seen from `perspective` (an entity id). */
export function describeRelation(r: Relation, perspective: string, nameOf: (id: string) => string): string {
  const cols = (cs: readonly string[]) => (cs.length ? cs.join(', ') : '?');
  if (r.cardinality === 'many-to-many') {
    const other = r.from === perspective ? r.to : r.from;
    return `↔ ${nameOf(other)}${r.throughName ? ` via ${r.throughName}` : ''} (many-to-many)`;
  }
  if (r.from === perspective) {
    return `${cols(r.fromColumns)} → ${nameOf(r.to)}.${cols(r.toColumns)} (${r.cardinality})`;
  }
  const back = r.cardinality === 'one-to-one' ? 'one-to-one' : 'one-to-many';
  return `← ${nameOf(r.from)}.${cols(r.fromColumns)} (${back})`;
}

export function enumSummary(e: EnumDef, max = 6): string {
  const shown = e.values.slice(0, max).join(', ');
  return e.values.length > max ? `${shown}, … (+${e.values.length - max})` : shown;
}

export const DERIVATION_LABELS: Readonly<Record<Provenance['derivation'], string>> = {
  declared: 'Declared',
  orm: 'ORM association',
  inferred: 'Inferred from naming',
  guessed: 'Name guessed',
  implied: 'Implied column',
  external: 'Not in workspace',
};

/** Provenance that deserves a visual "this is not certain" marker: anything but declared / ORM-declared with high-medium confidence. */
export function isUncertain(p: Provenance | undefined): boolean {
  return !!p && (p.derivation === 'inferred' || p.derivation === 'guessed' || p.derivation === 'implied' || p.derivation === 'external' || p.confidence === 'low');
}

/** One-line summary such as `Inferred from naming · low confidence · merged`. */
export function provenanceSummary(p: Provenance): string {
  return [DERIVATION_LABELS[p.derivation] ?? p.derivation, `${p.confidence} confidence`, ...(p.merged ? ['merged'] : [])].join(' · ');
}

/** Plain-text lines for a "Why is this here?" tooltip: summary, explanations, then up to 5 source locations. */
export function provenanceTextLines(p: Provenance): string[] {
  const lines = [provenanceSummary(p), ...p.notes];
  if (p.refs.length) {
    const shown = p.refs.slice(0, 5).map((r) => `${r.file}:${r.line + 1}`);
    lines.push(`From ${shown.join(', ')}${p.refs.length > 5 ? `, +${p.refs.length - 5} more` : ''}`);
  }
  return lines;
}
