/**
 * Resolver: merges the raw parse results of every file into one consistent schema.
 *
 * Pipeline
 *  1. prepare  – clone the raw output, drop unconfirmed ORM candidates, copy columns of abstract
 *                bases, flip one-to-many relations, unify ORM table names, redirect single-table
 *                inheritance children into their base table
 *  2. replay   – definition files are merged into one store; migration files are replayed in
 *                chronological order into another (drop / rename / alter ops)
 *  3. combine  – per table, the current definitions win over the migration history
 *  4. link     – relation references are resolved (model name, table name, conventions);
 *                unknown targets become `external` placeholder entities
 *  5. enrich   – FK column guessing, de-duplication, 1:1 detection, enum links, inferred relations,
 *                join-table detection
 *
 * Pure TypeScript without Node APIs (runs in the desktop and the web extension host).
 */

import {
  ENGINES,
  SOURCE_KINDS,
  SOURCE_LABELS,
  type Cardinality,
  type Column,
  type ColumnPatch,
  type EngineHint,
  type EngineId,
  type EngineInfo,
  type Entity,
  type EntityKind,
  type EntityRef,
  type EnumDef,
  type FileResult,
  type IndexDef,
  type ParseResult,
  type RawEntity,
  type RawEnum,
  type RawRelation,
  type Relation,
  type RelationKind,
  type ScanStats,
  type ScanWarning,
  type SchemaModel,
  type SchemaOp,
  type SourceKind,
  type SourceRef,
  type SourceSummary,
} from './model';
import { camelCase, defaultTableName, naturalCompare, pascalCase, pluralize, shortName, singularize, snakeCase } from './naming';
import { baseName, column, dirName } from './parser';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Infer relations from naming conventions (`user_id` → `users.id`). Default `true`. */
  inferRelations?: boolean;
}

export interface ResolvedSchema {
  entities: Entity[];
  relations: Relation[];
  enums: EnumDef[];
  warnings: ScanWarning[];
}

const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main']);

/** `public`, `dbo` and `main` (and empty values) are treated as "no schema". */
export function normalizeSchema(schema: string | undefined): string | undefined {
  const s = schema?.trim();
  return !s || DEFAULT_SCHEMAS.has(s.toLowerCase()) ? undefined : s;
}

/** Stable entity id: `users`, `auth.users`, `doc:users` (document collections live in their own namespace). */
export function entityId(kind: EntityKind, schema: string | undefined, name: string): string {
  const s = normalizeSchema(schema);
  return (kind === 'collection' ? 'doc:' : '') + (s ? `${s}.${name}` : name).toLowerCase();
}

export function enumId(schema: string | undefined, name: string): string {
  const s = normalizeSchema(schema);
  return (s ? `${s}.${name}` : name).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Origin = 'definition' | 'migration';

const lower = (s: string): string => s.toLowerCase();
const same = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
const loose = (s: string): string => s.toLowerCase().replace(/[\s_-]/g, '');

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a.map(lower));
  return b.every((x) => s.has(lower(x)));
}

function findColumn(columns: readonly Column[], name: string): Column | undefined {
  const n = lower(name);
  return columns.find((c) => lower(c.name) === n);
}

/** Exact (case-insensitive) match, else a unique match ignoring `_`, `-` and spaces (`authorId` ≈ `author_id`). */
function findColumnLoose(columns: readonly Column[], name: string): Column | undefined {
  const exact = findColumn(columns, name);
  if (exact) return exact;
  const n = loose(name);
  const hits = columns.filter((c) => loose(c.name) === n);
  return hits.length === 1 ? hits[0] : undefined;
}

function modelKey(kind: SourceKind, model: string): string {
  return `${kind}:${lower(shortName(model))}`;
}

function cloneColumn(c: Column): Column {
  const out: Column = { ...c };
  if (c.source) out.source = { ...c.source };
  delete out.references; // computed by the resolver; `enumRef` may be a parser hint (enum name)
  return out;
}

function cloneEntity(r: RawEntity): RawEntity {
  return {
    ...r,
    name: r.name.trim(),
    columns: (r.columns ?? []).map(cloneColumn),
    indexes: r.indexes?.map((ix) => ({ ...ix, columns: [...ix.columns] })),
    extends: r.extends ? [...r.extends] : undefined,
    source: { ...r.source },
  };
}

function cloneRelation(r: RawRelation): RawRelation {
  return {
    ...r,
    from: { ...r.from },
    to: { ...r.to },
    through: r.through ? { ...r.through } : undefined,
    fromColumns: [...(r.fromColumns ?? [])],
    toColumns: [...(r.toColumns ?? [])],
    source: { ...r.source },
  };
}

/** Fills attributes that `target` does not know yet from `from` (first source wins). */
function fillMissing(target: Column, from: Column): void {
  if (!target.type && from.type) target.type = from.type;
  if (target.default === undefined && from.default !== undefined) target.default = from.default;
  if (target.comment === undefined && from.comment !== undefined) target.comment = from.comment;
  if (target.generated === undefined && from.generated !== undefined) target.generated = from.generated;
  if (target.isArray === undefined && from.isArray !== undefined) target.isArray = from.isArray;
  if (target.enumRef === undefined && from.enumRef !== undefined) target.enumRef = from.enumRef;
  if (target.source === undefined && from.source !== undefined) target.source = from.source;
}

/** Replaces `target`'s attributes with `next`'s, keeping what `next` does not know (latest source wins). */
function overlay(target: Column, next: Column): void {
  const previous = { ...target };
  Object.assign(target, next);
  fillMissing(target, previous);
}

function applyPatch(c: Column, set: ColumnPatch): void {
  for (const [k, v] of Object.entries(set)) {
    if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
  }
  if (set.primaryKey) c.nullable = false;
}

function sameIndex(a: IndexDef, b: IndexDef): boolean {
  if (a.name && b.name && same(a.name, b.name)) return true;
  return a.unique === b.unique && a.columns.length === b.columns.length && a.columns.every((c, i) => same(c, b.columns[i]));
}

function pgDefaultFkNames(table: string, cols: readonly string[]): string[] {
  const base = `${table}_${cols.join('_')}`;
  return [`${base}_fkey`, `${base}_foreign`, `fk_${base}`];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 1: prepare raw items
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface EntityItem {
  raw: RawEntity;
  kind: SourceKind;
  file: string;
  origin: Origin;
  order: number;
  work: number;
  /** Single-table-inheritance child merged into its base's table. */
  redirected?: boolean;
}

interface RelationItem {
  raw: RawRelation;
  kind: SourceKind;
  file: string;
  origin: Origin;
  work: number;
}

interface Work {
  file: string;
  kind: SourceKind;
  origin: Origin;
  result: ParseResult;
  entities: EntityItem[];
  relations: RelationItem[];
}

function prepare(results: readonly FileResult[], warnings: ScanWarning[]): Work[] {
  let order = 0;
  const works: Work[] = results.map((fr, w) => {
    const origin: Origin = fr.result.origin ?? 'definition';
    const entities: EntityItem[] = [];
    for (const raw of fr.result.entities ?? []) {
      if (!raw?.name?.trim()) {
        warnings.push({ file: fr.file, line: raw?.source?.line, message: 'Ignored an entity without a name.' });
        continue;
      }
      entities.push({ raw: cloneEntity(raw), kind: fr.kind, file: fr.file, origin, order: order++, work: w });
    }
    const relations = (fr.result.relations ?? []).map(
      (raw): RelationItem => ({ raw: cloneRelation(raw), kind: fr.kind, file: fr.file, origin, work: w }),
    );
    return { file: fr.file, kind: fr.kind, origin, result: fr.result, entities, relations };
  });

  let entities = works.flatMap((w) => w.entities);
  let relations = works.flatMap((w) => w.relations);
  ({ entities, relations } = filterCandidates(entities, relations));
  ({ entities, relations } = applyInheritance(entities, relations));
  for (const r of relations) flipOneToMany(r.raw);
  unifyNames(entities);
  applySharedTables(entities);

  for (const w of works) {
    w.entities = [];
    w.relations = [];
  }
  for (const e of entities) works[e.work].entities.push(e);
  for (const r of relations) works[r.work].relations.push(r);
  return works;
}

/**
 * Owned / embedded value types (`RawRelation.owned`) are stored inside their owner's table:
 * removes the owner's navigation relation to them, the `<Nav>Id` column that relation implied,
 * and the value type's candidate entity – unless something else confirms it as a real table.
 */
function dropOwnedTypes(entities: EntityItem[], relations: RelationItem[]) {
  const markers = relations.filter((r) => r.raw.owned);
  if (!markers.length) return { entities, relations };
  const ownedModels = new Set<string>();
  const removed = new Set<RelationItem>(markers);
  const phantomColumns = new Map<string, Set<string>>(); // owner model key → column names
  for (const m of markers) {
    const owner = m.raw.from.model;
    if (!owner) continue;
    const ownerKey = modelKey(m.kind, owner);
    if (m.raw.to.model) ownedModels.add(modelKey(m.kind, m.raw.to.model));
    const nav = m.raw.name;
    if (!nav) continue;
    for (const r of relations) {
      if (r.raw.owned || r.kind !== m.kind || r.raw.cardinality === 'many-to-many' || !r.raw.from.model) continue;
      if (modelKey(r.kind, r.raw.from.model) !== ownerKey) continue;
      const fk = r.raw.fromColumns[0];
      const viaNav = r.raw.navigation
        ? same(r.raw.navigation, nav)
        : (fk && same(fk, `${nav}Id`)) || (r.raw.to.model && same(shortName(r.raw.to.model), nav));
      if (!viaNav) continue;
      removed.add(r);
      if (r.raw.to.model) ownedModels.add(modelKey(r.kind, r.raw.to.model));
      if (fk) {
        let set = phantomColumns.get(ownerKey);
        if (!set) phantomColumns.set(ownerKey, (set = new Set()));
        set.add(lower(fk));
      }
    }
  }
  // Real tables (non-candidates, e.g. a DbSet<T>) stay, whatever else says.
  for (const e of entities) if (!e.raw.candidate && e.raw.modelName) ownedModels.delete(modelKey(e.kind, e.raw.modelName));
  for (const e of entities) {
    const cols = e.raw.modelName ? phantomColumns.get(modelKey(e.kind, e.raw.modelName)) : undefined;
    if (cols) e.raw.columns = e.raw.columns.filter((c) => !(cols.has(lower(c.name)) && !c.type && !c.primaryKey));
  }
  const isOwned = (kind: SourceKind, ref: EntityRef | undefined) => !!ref?.model && ownedModels.has(modelKey(kind, ref.model));
  return {
    entities: entities.filter((e) => !(e.raw.candidate && e.raw.modelName && ownedModels.has(modelKey(e.kind, e.raw.modelName)))),
    relations: relations.filter((r) => !removed.has(r) && !isOwned(r.kind, r.raw.to) && !isOwned(r.kind, r.raw.from)),
  };
}

/** Drops maybe-entities that nothing confirms (see `RawEntity.candidate`). */
function filterCandidates(entities: EntityItem[], relations: RelationItem[]) {
  ({ entities, relations } = dropOwnedTypes(entities, relations));
  if (!entities.some((e) => e.raw.candidate)) return { entities, relations };
  const candidates = new Map<string, EntityItem[]>();
  const confirmed = new Set<string>();
  for (const it of entities) {
    const m = it.raw.modelName;
    if (!m) continue;
    if (it.raw.candidate) push(candidates, modelKey(it.kind, m), it);
    else confirmed.add(modelKey(it.kind, m));
  }

  // Navigation discovery: models referenced by relations of kept models are kept too.
  const byFrom = new Map<string, RelationItem[]>();
  for (const r of relations) if (r.raw.from.model) push(byFrom, modelKey(r.kind, r.raw.from.model), r);
  const queue = [...confirmed];
  while (queue.length) {
    const k = queue.pop()!;
    for (const r of byFrom.get(k) ?? []) {
      for (const ref of [r.raw.to, r.raw.through]) {
        if (!ref?.model) continue;
        const tk = modelKey(r.kind, ref.model);
        if (candidates.has(tk) && !confirmed.has(tk)) {
          confirmed.add(tk);
          queue.push(tk);
        }
      }
    }
  }

  // Unconfirmed candidates that are bases of kept entities act as abstract bases.
  const bases = new Set<string>();
  const stack: string[] = [];
  for (const it of entities) {
    const kept = !it.raw.candidate || (it.raw.modelName && confirmed.has(modelKey(it.kind, it.raw.modelName)));
    if (kept) for (const b of it.raw.extends ?? []) stack.push(modelKey(it.kind, b));
  }
  while (stack.length) {
    const k = stack.pop()!;
    if (bases.has(k)) continue;
    bases.add(k);
    for (const it of candidates.get(k) ?? []) for (const b of it.raw.extends ?? []) stack.push(modelKey(it.kind, b));
  }

  const droppedModels = new Set<string>();
  const dropped = new Set<EntityItem>();
  for (const it of entities) {
    if (!it.raw.candidate) continue;
    const k = it.raw.modelName ? modelKey(it.kind, it.raw.modelName) : undefined;
    if (k && confirmed.has(k)) continue;
    if (k && bases.has(k)) {
      it.raw.abstract = true;
      continue;
    }
    dropped.add(it);
    if (k) droppedModels.add(k);
  }
  return {
    entities: entities.filter((e) => !dropped.has(e)),
    relations: relations.filter((r) => !(r.raw.from.model && droppedModels.has(modelKey(r.kind, r.raw.from.model)))),
  };
}

/** Copies columns (and relations) of abstract bases into concrete entities and removes the abstract ones. */
function applyInheritance(entities: EntityItem[], relations: RelationItem[]) {
  if (!entities.some((e) => e.raw.abstract)) return { entities, relations };
  const abstracts = new Map<string, EntityItem>();
  const concrete = new Set<string>();
  for (const it of entities) {
    if (!it.raw.modelName) continue;
    const k = modelKey(it.kind, it.raw.modelName);
    if (it.raw.abstract) {
      if (!abstracts.has(k)) abstracts.set(k, it);
    } else concrete.add(k);
  }

  const descendants = new Map<string, EntityItem[]>();
  for (const it of entities) {
    if (it.raw.abstract || !it.raw.extends?.length) continue;
    const inherited: Column[] = [];
    const seen = new Set<string>();
    const visit = (base: string) => {
      const k = modelKey(it.kind, base);
      if (seen.has(k)) return;
      seen.add(k);
      const a = abstracts.get(k);
      if (!a) return;
      for (const b of a.raw.extends ?? []) visit(b);
      push(descendants, k, it);
      for (const c of a.raw.columns) if (!findColumn(inherited, c.name)) inherited.push(cloneColumn(c));
    };
    for (const b of it.raw.extends) visit(b);
    if (inherited.length) {
      const own = it.raw.columns;
      it.raw.columns = [...inherited.filter((c) => !findColumn(own, c.name)), ...own];
    }
  }

  const out: RelationItem[] = [];
  for (const r of relations) {
    const fk = r.raw.from.model ? modelKey(r.kind, r.raw.from.model) : undefined;
    const tk = r.raw.to.model ? modelKey(r.kind, r.raw.to.model) : undefined;
    if (tk && abstracts.has(tk) && !concrete.has(tk)) continue; // cannot point at a non-table
    if (fk && abstracts.has(fk) && !concrete.has(fk)) {
      for (const child of descendants.get(fk) ?? []) {
        const raw = cloneRelation(r.raw);
        raw.from = { model: child.raw.modelName, name: child.raw.name, schema: child.raw.schema };
        out.push({ ...r, raw, work: child.work, file: child.file });
      }
      continue;
    }
    out.push(r);
  }
  return { entities: entities.filter((e) => !e.raw.abstract), relations: out };
}

function flipOneToMany(r: RawRelation): void {
  if (r.cardinality !== 'one-to-many') return;
  [r.from, r.to] = [r.to, r.from];
  [r.fromColumns, r.toColumns] = [r.toColumns, r.fromColumns];
  r.cardinality = 'many-to-one';
}

function certainty(it: EntityItem): number {
  return it.raw.nameCertainty ?? 2;
}

function better(a: EntityItem, b: EntityItem): boolean {
  if (certainty(a) !== certainty(b)) return certainty(a) > certainty(b);
  if (!!a.raw.partial !== !!b.raw.partial) return !a.raw.partial;
  if (!!a.raw.columns.length !== !!b.raw.columns.length) return a.raw.columns.length > 0;
  return a.order < b.order;
}

/** Raw entities of one ORM that share a model name adopt the most certain table name. */
function unifyNames(entities: EntityItem[]): void {
  const groups = new Map<string, EntityItem[]>();
  for (const it of entities) if (it.raw.modelName) push(groups, modelKey(it.kind, it.raw.modelName), it);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const best = group.reduce((b, it) => (better(it, b) ? it : b));
    const bc = certainty(best);
    for (const it of group) {
      if (it === best || certainty(it) >= bc) continue;
      it.raw.name = best.raw.name;
      it.raw.schema = best.raw.schema;
      it.raw.nameCertainty = bc as 0 | 1 | 2;
    }
  }
}

/** Single-table inheritance: children whose base is a concrete entity are stored in the base's table. */
function applySharedTables(entities: EntityItem[]): void {
  if (!entities.some((e) => e.raw.sharedTable)) return;
  const concrete = new Map<string, EntityItem>();
  for (const it of entities) {
    if (!it.raw.modelName) continue;
    const k = modelKey(it.kind, it.raw.modelName);
    const cur = concrete.get(k);
    if (!cur || better(it, cur)) concrete.set(k, it);
  }
  for (const it of entities) {
    if (!it.raw.sharedTable || !it.raw.extends?.length) continue;
    let root: EntityItem | undefined;
    let cur = it;
    const seen = new Set<EntityItem>([it]);
    while (cur.raw.sharedTable && cur.raw.extends?.length) {
      const base = concrete.get(modelKey(cur.kind, cur.raw.extends[0]));
      if (!base || seen.has(base)) break;
      seen.add(base);
      root = base;
      cur = base;
    }
    if (root) {
      it.raw.name = root.raw.name;
      it.raw.schema = root.raw.schema;
      it.raw.kind = root.raw.kind;
      it.redirected = true;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 2: stores (definitions / migration replay)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ModelTag {
  name: string;
  kind: SourceKind;
  /** Single-table-inheritance child stored in this table. */
  child?: boolean;
}

interface WEntity {
  key: string;
  name: string;
  schema?: string;
  kind: EntityKind;
  models: ModelTag[];
  columns: Column[];
  indexes: IndexDef[];
  comment?: string;
  sources: SourceKind[];
  files: string[];
  primary?: SourceRef;
  primaryScore: number;
  engine?: EngineId;
  group?: string;
  /** A non-partial raw entity with at least one column contributed: the column list is complete. */
  full: boolean;
  /** The column list comes from definitions (migration relations must match it). */
  columnsFromDefinition?: boolean;
  /** File of the first non-partial raw entity (scopes destructive ops in definition files). */
  createdIn?: string;
  /** Some contributor named the table explicitly (nameCertainty 2). */
  certain?: boolean;
  /** Former (guessed) names that relations may still use. */
  aliases?: string[];
  /** Files whose raw entities contributed at least one column. */
  columnFiles?: string[];
  external?: boolean;
  joinTable?: boolean;
}

interface WEnum {
  key: string;
  name: string;
  schema?: string;
  values: string[];
  sources: SourceKind[];
  source?: SourceRef;
  createdIn?: string;
}

interface StoredRelation {
  raw: RawRelation;
  kind: SourceKind;
  file: string;
  origin: Origin;
}

type OpResult = 'applied' | 'skipped' | 'missing';

const DDL_KINDS = new Set<SourceKind>(['sql', 'dbml', 'diesel']);

function sourceScore(item: EntityItem): number {
  const r = item.raw;
  let s = item.origin === 'definition' ? 100 : 0;
  if (!r.partial) s += 20;
  if (r.columns.length) s += 10;
  if (!DDL_KINDS.has(item.kind)) s += 3; // prefer the ORM model class for "Go to definition"
  if (item.redirected) s -= 15; // the base class, not an STI child, defines the table
  return s + certainty(item);
}

function refIs(ref: EntityRef | undefined, e: WEntity): boolean {
  if (!ref) return false;
  if (ref.name) {
    if (!same(ref.name, e.name)) return false;
    const s = normalizeSchema(ref.schema);
    return !s || same(s, e.schema);
  }
  if (ref.model) {
    const m = shortName(ref.model);
    return e.models.some((t) => same(t.name, m));
  }
  return false;
}

class Store {
  readonly entities = new Map<string, WEntity>();
  readonly enums = new Map<string, WEnum>();
  relations: StoredRelation[] = [];
  readonly dropped = new Set<string>();
  readonly droppedEnums = new Set<string>();

  constructor(private readonly origin: Origin) {}

  /** Latest statement wins in migrations; first source wins in definitions. */
  private get newWins(): boolean {
    return this.origin === 'migration';
  }

  find(ref: EntityRef): WEntity | undefined {
    if (ref.name) {
      const e =
        this.entities.get(entityId('table', ref.schema, ref.name)) ??
        this.entities.get(entityId('collection', ref.schema, ref.name));
      if (e || normalizeSchema(ref.schema)) return e;
      for (const x of this.entities.values()) if (same(x.name, ref.name)) return x;
      return undefined;
    }
    if (ref.model) {
      const m = shortName(ref.model);
      for (const x of this.entities.values()) if (x.models.some((t) => same(t.name, m))) return x;
    }
    return undefined;
  }

  upsertEntity(item: EntityItem): void {
    const r = item.raw;
    const schema = normalizeSchema(r.schema);
    const key = entityId(r.kind, schema, r.name);
    let e = this.entities.get(key);
    if (!e) {
      e = {
        key,
        name: r.name,
        schema,
        kind: r.kind,
        models: [],
        columns: [],
        indexes: [],
        sources: [],
        files: [],
        primaryScore: -1,
        full: false,
      };
      this.entities.set(key, e);
    }
    if (!r.partial && e.createdIn === undefined) e.createdIn = item.file;
    if (certainty(item) >= 2) e.certain = true;
    this.dropped.delete(key);

    for (const c of r.columns) {
      const existing = findColumn(e.columns, c.name);
      if (!existing) e.columns.push(cloneColumn(c));
      else if (this.newWins) overlay(existing, cloneColumn(c));
      else fillMissing(existing, c);
    }
    if (!r.partial && r.columns.length) e.full = true;
    if (r.columns.length) addUnique((e.columnFiles ??= []), item.file);
    for (const ix of r.indexes ?? []) addIndex(e, ix);
    if (r.modelName) {
      const name = shortName(r.modelName);
      if (!e.models.some((t) => t.kind === item.kind && same(t.name, name))) {
        e.models.push(item.redirected ? { name, kind: item.kind, child: true } : { name, kind: item.kind });
      }
    }
    addUnique(e.sources, item.kind);
    addUnique(e.files, item.file);
    if (r.comment !== undefined && (this.newWins || e.comment === undefined)) e.comment = r.comment;
    if (!e.engine && r.engine) e.engine = r.engine;
    if (!e.group && r.group) e.group = r.group;
    const score = sourceScore(item);
    if (score > e.primaryScore) {
      e.primary = { ...r.source };
      e.primaryScore = score;
    }
  }

  upsertEnum(raw: RawEnum, kind: SourceKind, file: string): void {
    if (!raw?.name?.trim()) return;
    const schema = normalizeSchema(raw.schema);
    const key = enumId(schema, raw.name);
    this.droppedEnums.delete(key);
    const existing = this.enums.get(key);
    if (!existing) {
      this.enums.set(key, {
        key,
        name: raw.name,
        schema,
        values: [...new Set(raw.values)],
        sources: [kind],
        source: { ...raw.source },
        createdIn: raw.partial ? undefined : file,
      });
      return;
    }
    addUnique(existing.sources, kind);
    if (raw.partial || !this.newWins) {
      for (const v of raw.values) addUnique(existing.values, v);
    } else {
      existing.values = [...new Set(raw.values)];
      existing.source = { ...raw.source };
    }
    if (!raw.partial && existing.createdIn === undefined) existing.createdIn = file;
  }

  addRelation(item: RelationItem): void {
    this.relations.push({ raw: item.raw, kind: item.kind, file: item.file, origin: this.origin });
  }

  apply(op: SchemaOp, file: string): OpResult {
    const localOnly = this.origin === 'definition';
    if (op.op === 'dropEnum' || op.op === 'renameEnum') {
      const key = enumId(op.schema, op.name);
      const en = this.enums.get(key);
      if (!en) return 'missing';
      if (localOnly && en.createdIn !== file) return 'skipped';
      this.enums.delete(key);
      if (op.op === 'dropEnum') {
        this.droppedEnums.add(key);
      } else {
        en.name = op.to;
        en.key = enumId(en.schema, op.to);
        this.enums.set(en.key, en);
      }
      return 'applied';
    }

    const e = this.find(op.table);
    if (!e) {
      if (op.op === 'dropTable' && op.table.name && !localOnly) this.dropped.add(entityId('table', op.table.schema, op.table.name));
      return 'missing';
    }
    // Column-level mapping config (alter / rename) may target entities of other definition files,
    // e.g. EF Core fluent `HasColumnName` in a DbContext; dropping things stays file-local.
    if (localOnly && op.op !== 'alterColumn' && op.op !== 'renameColumn' && e.createdIn !== file) return 'skipped';

    switch (op.op) {
      case 'dropTable':
        this.entities.delete(e.key);
        this.dropped.add(e.key);
        this.relations = this.relations.filter((r) => !refIs(r.raw.from, e));
        return 'applied';

      case 'renameTable': {
        const to = op.to.trim();
        if (!to) return 'skipped';
        const hits = this.relations.map((r) => [refIs(r.raw.from, e), refIs(r.raw.to, e), refIs(r.raw.through, e)]);
        this.entities.delete(e.key);
        this.dropped.add(e.key);
        e.name = to;
        e.key = entityId(e.kind, e.schema, to);
        this.entities.set(e.key, e);
        this.dropped.delete(e.key);
        this.relations.forEach((r, i) => {
          const [f, t, th] = hits[i];
          if (f) r.raw.from = { ...r.raw.from, name: to };
          if (t) r.raw.to = { ...r.raw.to, name: to };
          if (th && r.raw.through) r.raw.through = { ...r.raw.through, name: to };
        });
        return 'applied';
      }

      case 'dropColumn': {
        const idx = e.columns.findIndex((c) => same(c.name, op.column));
        if (idx < 0) return 'skipped';
        e.columns.splice(idx, 1);
        e.indexes = e.indexes.filter((ix) => !ix.columns.some((c) => same(c, op.column)));
        this.relations = this.relations.filter(
          (r) => !(r.raw.cardinality !== 'many-to-many' && refIs(r.raw.from, e) && r.raw.fromColumns.some((c) => same(c, op.column))),
        );
        return 'applied';
      }

      case 'renameColumn': {
        const c = findColumn(e.columns, op.column);
        if (!c) return 'missing'; // may be declared by a definition file that is merged later
        const old = c.name;
        c.name = op.to;
        const rename = (cols: string[]) => cols.map((x) => (same(x, old) ? op.to : x));
        for (const ix of e.indexes) ix.columns = rename(ix.columns);
        for (const r of this.relations) {
          if (refIs(r.raw.from, e)) r.raw.fromColumns = rename(r.raw.fromColumns);
          if (refIs(r.raw.to, e)) r.raw.toColumns = rename(r.raw.toColumns);
        }
        return 'applied';
      }

      case 'alterColumn': {
        const c = findColumn(e.columns, op.column);
        if (!c) return 'missing';
        applyPatch(c, op.set);
        return 'applied';
      }

      case 'dropForeignKey': {
        const before = this.relations.length;
        this.relations = this.relations.filter((r) => {
          if (r.raw.cardinality === 'many-to-many' || !refIs(r.raw.from, e)) return true;
          if (op.name) {
            const names = r.raw.name ? [r.raw.name] : pgDefaultFkNames(e.name, r.raw.fromColumns);
            if (names.some((n) => same(n, op.name))) return false;
          }
          if (op.columns?.length && sameSet(op.columns, r.raw.fromColumns)) return false;
          if (!op.name && !op.columns?.length && op.to?.name && same(r.raw.to.name, op.to.name)) return false;
          return true;
        });
        return this.relations.length < before ? 'applied' : 'skipped';
      }
    }
  }
}

function addIndex(e: WEntity, ix: IndexDef): void {
  if (!ix.columns?.length) return;
  const copy: IndexDef = { ...ix, columns: [...ix.columns] };
  const i = e.indexes.findIndex((x) => sameIndex(x, copy));
  if (i >= 0) e.indexes[i] = { ...e.indexes[i], ...copy, name: copy.name ?? e.indexes[i].name };
  else e.indexes.push(copy);
}

type Step =
  | { t: 0; line: number; i: number; item: EntityItem }
  | { t: 1; line: number; i: number; raw: RawEnum }
  | { t: 2; line: number; i: number; item: RelationItem }
  | { t: 3; line: number; i: number; op: SchemaOp };

/** Items of one file in line order (entities, enums, relations, ops on the same line in that order). */
function steps(w: Work): Step[] {
  const out: Step[] = [];
  let i = 0;
  for (const item of w.entities) out.push({ t: 0, line: item.raw.source?.line ?? 0, i: i++, item });
  for (const raw of w.result.enums ?? []) out.push({ t: 1, line: raw?.source?.line ?? 0, i: i++, raw });
  for (const item of w.relations) out.push({ t: 2, line: item.raw.source?.line ?? 0, i: i++, item });
  for (const op of w.result.ops ?? []) out.push({ t: 3, line: op?.source?.line ?? 0, i: i++, op });
  return out.sort((a, b) => a.line - b.line || a.t - b.t || a.i - b.i);
}

function runSteps(store: Store, w: Work, deferred?: { op: SchemaOp; file: string }[]): void {
  for (const s of steps(w)) {
    if (s.t === 0) store.upsertEntity(s.item);
    else if (s.t === 1) store.upsertEnum(s.raw, w.kind, w.file);
    else if (s.t === 2) store.addRelation(s.item);
    else {
      const result = store.apply(s.op, w.file);
      const retry = s.op.op === 'alterColumn' || s.op.op === 'renameColumn';
      if (deferred && retry && result === 'missing') deferred.push({ op: s.op, file: w.file });
    }
  }
}

const KIND_RANK = new Map<SourceKind, number>(SOURCE_KINDS.map((k, i) => [k, i]));

function feedDefinitions(store: Store, works: Work[]): void {
  const sorted = [...works].sort(
    (a, b) => (KIND_RANK.get(a.kind) ?? 99) - (KIND_RANK.get(b.kind) ?? 99) || naturalCompare(a.file, b.file),
  );
  const deferred: { op: SchemaOp; file: string }[] = [];
  for (const w of sorted) runSteps(store, w, deferred);
  for (const d of deferred) store.apply(d.op, d.file);
}

function flywayVersion(file: string): number[] | undefined {
  const m = /^V(\d+(?:[._]\d+)*)__/i.exec(baseName(file));
  return m ? m[1].split(/[._]/).map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Chronological order of migration files: directory, then Flyway versions / natural file names. */
export function compareMigrationPaths(a: string, b: string): number {
  const d = naturalCompare(dirName(a), dirName(b));
  if (d) return d;
  const va = flywayVersion(a);
  const vb = flywayVersion(b);
  if (va && vb) return compareVersions(va, vb) || naturalCompare(a, b);
  const ra = /^R__/i.test(baseName(a));
  const rb = /^R__/i.test(baseName(b));
  if (ra !== rb) return ra ? 1 : -1; // Flyway repeatable migrations run after versioned ones
  return naturalCompare(baseName(a), baseName(b));
}

/** Sorts migrations; files with an explicit revision graph (Alembic) are topologically ordered among themselves. */
export function orderMigrations<T extends { file: string; result: ParseResult }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => compareMigrationPaths(a.file, b.file));
  const slots: number[] = [];
  const graph: T[] = [];
  sorted.forEach((it, i) => {
    if (it.result.migration?.id) {
      slots.push(i);
      graph.push(it);
    }
  });
  if (graph.length < 2) return sorted;

  const byId = new Map<string, number>();
  graph.forEach((it, i) => byId.set(it.result.migration!.id, i));
  const indegree = graph.map(() => 0);
  const children = graph.map((): number[] => []);
  graph.forEach((it, i) => {
    for (const parent of new Set(it.result.migration!.after ?? [])) {
      const p = byId.get(parent);
      if (p === undefined || p === i) continue;
      children[p].push(i);
      indegree[i]++;
    }
  });
  const done = graph.map(() => false);
  const ready = new Set<number>();
  indegree.forEach((d, i) => d === 0 && ready.add(i));
  const ordered: T[] = [];
  while (ordered.length < graph.length) {
    let next = -1;
    for (const i of ready) if (next < 0 || i < next) next = i;
    if (next < 0) {
      next = done.findIndex((x) => !x); // cycle: fall back to path order
    } else ready.delete(next);
    done[next] = true;
    ordered.push(graph[next]);
    for (const c of children[next]) if (--indegree[c] === 0 && !done[c]) ready.add(c);
  }
  slots.forEach((slot, j) => (sorted[slot] = ordered[j]));
  return sorted;
}

function feedMigrations(store: Store, works: Work[]): void {
  for (const w of orderMigrations(works)) runSteps(store, w);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 3: combine definitions and migration history
// ─────────────────────────────────────────────────────────────────────────────────────────────

function combine(defs: Store, migs: Store): Map<string, WEntity> {
  const out = new Map<string, WEntity>(migs.entities);
  for (const [key, d] of defs.entities) {
    const m = out.get(key);
    out.set(key, m ? mergeDefinitionOverMigration(d, m) : { ...d, columnsFromDefinition: d.full });
  }
  reconcileGuessedNames(out);
  return out;
}

/** Plausible real names for an entity whose table name was derived by convention. */
function nameVariants(e: WEntity): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !same(s, e.name) && !out.some((x) => same(x, s))) out.push(s);
  };
  for (const base of [e.name, ...e.models.map((m) => m.name)]) {
    const snake = snakeCase(base);
    for (const v of [base, pluralize(base), singularize(base), snake, pluralize(snake), singularize(snake), pluralize(base.toLowerCase())]) add(v);
  }
  return out;
}

/**
 * An ORM model whose table name was only guessed (e.g. EF Core `Post`, TypeORM `user`) adopts an
 * explicitly named table that matches a naming variant (`Posts`, `users`) instead of appearing twice.
 */
function reconcileGuessedNames(all: Map<string, WEntity>): void {
  const index = new Map<string, WEntity[]>();
  const keyOf = (kind: EntityKind, schema: string | undefined, name: string) => `${kind}|${lower(schema ?? '')}|${lower(name)}`;
  for (const e of all.values()) push(index, keyOf(e.kind, e.schema, e.name), e);
  for (const e of [...all.values()]) {
    if (e.certain || e.external || !e.models.length) continue;
    const kinds = new Set(e.models.map((m) => m.kind));
    let target: WEntity | undefined;
    for (const variant of nameVariants(e)) {
      const hits = (index.get(keyOf(e.kind, e.schema, variant)) ?? []).filter(
        (x) => x !== e && x.certain && all.has(x.key) && !x.models.some((m) => kinds.has(m.kind)),
      );
      if (hits.length === 1) {
        target = hits[0];
        break;
      }
    }
    if (!target) continue;
    all.delete(e.key);
    mergeGuessedInto(target, e);
  }
}

function mergeGuessedInto(t: WEntity, e: WEntity): void {
  if (e.full && e.columnsFromDefinition && !t.columnsFromDefinition) {
    // Current model definition vs. migration history: the definition's columns win (as for same-name tables).
    const history = t.columns;
    t.columns = e.columns.map((c) => {
      const tc = findColumnLoose(history, c.name);
      if (tc) fillMissing(c, tc);
      return c;
    });
    t.full = true;
    t.columnsFromDefinition = true;
  } else {
    for (const c of e.columns) {
      const tc = findColumnLoose(t.columns, c.name);
      if (tc) fillMissing(tc, c);
      else if (!t.full) t.columns.push(c); // the explicit table is complete: extra ORM fields are virtual
    }
    if (!t.full && e.full) t.full = true;
  }
  for (const ix of e.indexes) {
    if (ix.columns.every((c) => findColumnLoose(t.columns, c))) addIndex(t, { ...ix, columns: ix.columns.map((c) => findColumnLoose(t.columns, c)!.name) });
  }
  for (const m of e.models) if (!t.models.some((x) => x.kind === m.kind && same(x.name, m.name))) t.models.push(m);
  for (const k of e.sources) addUnique(t.sources, k);
  for (const f of e.files) addUnique(t.files, f);
  if (e.primaryScore > t.primaryScore && e.primary) {
    t.primary = e.primary;
    t.primaryScore = e.primaryScore;
  }
  t.comment ??= e.comment;
  t.engine ??= e.engine;
  t.group ??= e.group;
  t.columnFiles = [...new Set([...(t.columnFiles ?? []), ...(e.columnFiles ?? [])])];
  t.aliases = [...(t.aliases ?? []), e.name, ...(e.aliases ?? [])];
}

function mergeDefinitionOverMigration(d: WEntity, m: WEntity): WEntity {
  let columns: Column[];
  if (d.full) {
    columns = d.columns;
    for (const c of columns) {
      const mc = findColumn(m.columns, c.name);
      if (mc) fillMissing(c, mc);
    }
  } else {
    columns = m.columns;
    for (const c of d.columns) {
      const mc = findColumn(columns, c.name);
      if (mc) fillMissing(mc, c);
      else columns.push(c);
    }
  }
  const indexes = [...d.indexes];
  for (const ix of m.indexes) {
    if (ix.columns.every((c) => findColumn(columns, c)) && !indexes.some((x) => sameIndex(x, ix))) indexes.push(ix);
  }
  const models = [...d.models];
  for (const t of m.models) if (!models.some((x) => x.kind === t.kind && same(x.name, t.name))) models.push(t);
  const sources = [...d.sources];
  for (const k of m.sources) addUnique(sources, k);
  const files = [...d.files];
  for (const f of m.files) addUnique(files, f);
  return {
    ...d,
    columns,
    indexes,
    models,
    sources,
    files,
    comment: d.comment ?? m.comment,
    engine: d.engine ?? m.engine,
    group: d.group ?? m.group,
    primary: d.primary ?? m.primary,
    primaryScore: Math.max(d.primaryScore, m.primaryScore),
    full: d.full || m.full,
    columnsFromDefinition: d.full,
    certain: d.certain || m.certain,
    aliases: [...(d.aliases ?? []), ...(m.aliases ?? [])],
    columnFiles: [...new Set([...(d.columnFiles ?? []), ...(m.columnFiles ?? [])])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4: linking references
// ─────────────────────────────────────────────────────────────────────────────────────────────

class Linker {
  readonly byKey = new Map<string, WEntity>();
  private readonly byName = new Map<string, WEntity[]>();
  private readonly byModel = new Map<string, { e: WEntity; kind: SourceKind }[]>();

  constructor(
    entities: Iterable<WEntity>,
    private readonly dropped: ReadonlySet<string>,
  ) {
    for (const e of entities) this.add(e);
  }

  add(e: WEntity): void {
    this.byKey.set(e.key, e);
    push(this.byName, lower(e.name), e);
    for (const alias of e.aliases ?? []) if (!same(alias, e.name)) push(this.byName, lower(alias), e);
    for (const t of e.models) push(this.byModel, lower(t.name), { e, kind: t.kind });
  }

  entities(): WEntity[] {
    return [...this.byKey.values()];
  }

  resolve(ref: EntityRef, kind: SourceKind, ctx?: WEntity): WEntity | undefined {
    const preferDoc = ctx ? ctx.kind === 'collection' : kind === 'mongoose';
    const schema = normalizeSchema(ref.schema);
    if (ref.model) {
      const hit = this.model(ref.model, kind, ref.name, schema, ctx);
      if (hit) return hit;
    }
    if (ref.name) {
      const hit = this.name(ref.name, schema, preferDoc, ctx) ?? this.model(ref.name, kind, undefined, schema, ctx);
      if (hit) return hit;
      for (const variant of [pluralize(ref.name), singularize(ref.name)]) {
        if (variant === ref.name) continue;
        const v = this.name(variant, schema, preferDoc, ctx);
        if (v) return v;
      }
    }
    if (ref.model) {
      const short = shortName(ref.model);
      const guesses = new Set([defaultTableName(kind, short), snakeCase(short), pluralize(snakeCase(short)), short]);
      for (const n of guesses) {
        const v = this.name(n, schema, preferDoc, ctx);
        if (v) return v;
      }
    }
    return undefined;
  }

  name(name: string, schema: string | undefined, preferDoc: boolean, ctx?: WEntity): WEntity | undefined {
    const keys = preferDoc
      ? [entityId('collection', schema, name), entityId('table', schema, name)]
      : [entityId('table', schema, name), entityId('collection', schema, name)];
    for (const k of keys) {
      const e = this.byKey.get(k);
      if (e) return e;
    }
    if (schema) return undefined;
    const cands = this.byName.get(lower(name));
    if (!cands?.length) return undefined;
    if (cands.length === 1) return cands[0];
    return (
      (ctx && cands.find((c) => c.schema === ctx.schema && (c.kind === 'collection') === preferDoc)) ??
      cands.find((c) => (c.kind === 'collection') === preferDoc && !c.schema) ??
      cands[0]
    );
  }

  model(model: string, kind: SourceKind, name?: string, schema?: string, ctx?: WEntity): WEntity | undefined {
    const cands = this.byModel.get(lower(shortName(model)));
    if (!cands?.length) return undefined;
    const sameKind = cands.filter((c) => c.kind === kind);
    let pool = [...new Set((sameKind.length ? sameKind : cands).map((c) => c.e))];
    const narrow = (pred: (e: WEntity) => boolean) => {
      if (pool.length < 2) return;
      const f = pool.filter(pred);
      if (f.length) pool = f;
    };
    if (name) narrow((e) => same(e.name, name));
    if (schema) narrow((e) => same(e.schema, schema));
    if (ctx) narrow((e) => e.schema === ctx.schema);
    return pool[0];
  }

  /** Placeholder for a referenced entity that is not defined in the workspace. */
  external(ref: EntityRef, kind: SourceKind, toColumns: readonly string[], ctx?: WEntity): WEntity | undefined {
    const name = ref.name?.trim() || (ref.model ? defaultTableName(kind, shortName(ref.model)) : undefined);
    if (!name) return undefined;
    const ekind: EntityKind = ctx?.kind === 'collection' || kind === 'mongoose' ? 'collection' : 'table';
    const schema = normalizeSchema(ref.schema);
    const key = entityId(ekind, schema, name);
    if (this.dropped.has(key)) return undefined;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const cols = toColumns.length ? toColumns : ['id'];
    const e: WEntity = {
      key,
      name,
      schema,
      kind: ekind,
      models: ref.model ? [{ name: shortName(ref.model), kind }] : [],
      columns: cols.map((c) => column(c, '', { nullable: false, primaryKey: cols.length === 1 || /^_?id$/i.test(c) })),
      indexes: [],
      sources: [kind],
      files: [],
      primaryScore: -1,
      full: false,
      external: true,
    };
    this.add(e);
    return e;
  }
}

interface Link {
  from: WEntity;
  to: WEntity;
  fromColumns: string[];
  toColumns: string[];
  cardinality: Cardinality;
  kind: RelationKind;
  name?: string;
  onDelete?: string;
  onUpdate?: string;
  through?: WEntity;
  throughName?: string;
  explicitOptional?: boolean;
  optional?: boolean;
  sources: SourceKind[];
  source?: SourceRef;
}

function linkAll(stored: StoredRelation[], linker: Linker, warnings: ScanWarning[]): Link[] {
  const out: Link[] = [];
  for (const s of stored) {
    const r = s.raw;
    const from = linker.resolve(r.from, s.kind);
    if (!from) {
      warnings.push({
        file: r.source?.file ?? s.file,
        line: r.source?.line,
        message: `Relation ignored: entity "${r.from.name ?? r.from.model ?? '?'}" is not defined in the workspace.`,
      });
      continue;
    }
    if (s.origin === 'migration' && from.columnsFromDefinition && r.fromColumns.length && r.cardinality !== 'many-to-many') {
      if (!r.fromColumns.every((c) => findColumnLoose(from.columns, c))) continue; // stale FK from the history
    }
    const to = linker.resolve(r.to, s.kind, from) ?? linker.external(r.to, s.kind, r.toColumns, from);
    if (!to) continue;
    const link: Link = {
      from,
      to,
      fromColumns: [...r.fromColumns],
      toColumns: [...r.toColumns],
      cardinality: r.cardinality === 'one-to-many' ? 'many-to-one' : r.cardinality,
      kind: r.kind === 'orm' ? 'orm' : 'foreign-key',
      name: r.name,
      onDelete: r.onDelete,
      onUpdate: r.onUpdate,
      explicitOptional: r.optional,
      sources: [s.kind],
      source: r.source ? { ...r.source } : undefined,
    };
    if (link.cardinality === 'many-to-many' && r.through) {
      link.through = linker.resolve(r.through, s.kind, from);
      link.throughName = link.through?.name ?? r.through.name ?? (r.through.model ? shortName(r.through.model) : undefined);
    }
    out.push(link);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 5: enrichment
// ─────────────────────────────────────────────────────────────────────────────────────────────

const KIND_STRENGTH: Record<RelationKind, number> = { 'foreign-key': 3, orm: 2, inferred: 1 };

function keyColumns(e: WEntity): string[] {
  const pk = e.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pk.length) return pk;
  const id = findColumn(e.columns, 'id') ?? findColumn(e.columns, '_id');
  return id ? [id.name] : [];
}

function canonicalize(l: Link): void {
  const canon = (e: WEntity, c: string) => findColumnLoose(e.columns, c)?.name ?? c;
  l.fromColumns = l.fromColumns.map((c) => canon(l.from, c));
  l.toColumns = l.toColumns.map((c) => canon(l.to, c));
  if (!l.toColumns.length) l.toColumns = keyColumns(l.to);
  if (l.cardinality === 'many-to-many' && !l.fromColumns.length) l.fromColumns = keyColumns(l.from);
}

function mergeInto(a: Link, b: Link): void {
  if (KIND_STRENGTH[b.kind] > KIND_STRENGTH[a.kind]) a.kind = b.kind;
  if (b.cardinality === 'one-to-one' && a.cardinality === 'many-to-one') a.cardinality = 'one-to-one';
  a.name ??= b.name;
  a.onDelete ??= b.onDelete;
  a.onUpdate ??= b.onUpdate;
  a.explicitOptional ??= b.explicitOptional;
  a.source ??= b.source;
  if (!a.toColumns.length && b.toColumns.length) a.toColumns = b.toColumns;
  if (!a.through && b.through) a.through = b.through;
  if (!a.throughName && b.throughName) a.throughName = b.throughName;
  for (const k of b.sources) addUnique(a.sources, k);
}

/** FK column candidates in `from` for a reference to `to` when the parser could not tell. */
function guessFkColumns(from: WEntity, to: WEntity, toColumns: readonly string[]): string[] {
  if (!from.columns.length) return [];
  const bases = new Set<string>();
  for (const n of [to.name, ...to.models.map((m) => m.name)]) {
    bases.add(n);
    bases.add(singularize(n));
  }
  const pk = toColumns.length === 1 ? toColumns[0] : 'id';
  for (const b of bases) {
    for (const w of [`${snakeCase(b)}_${snakeCase(pk)}`, `${camelCase(b)}${pascalCase(pk)}`, `${snakeCase(b)}_id`, `${camelCase(b)}Id`]) {
      const c = findColumnLoose(from.columns, w);
      if (c) return [c.name];
    }
  }
  return [];
}

function dedupe(links: Link[]): Link[] {
  const out: Link[] = [];
  const byKey = new Map<string, Link>();
  const pending: Link[] = [];
  const keyOf = (l: Link) => `${l.from.key}|${[...l.fromColumns].map(lower).sort().join(',')}|${l.to.key}`;
  const add = (l: Link) => {
    const k = keyOf(l);
    const ex = byKey.get(k);
    if (ex) mergeInto(ex, l);
    else {
      byKey.set(k, l);
      out.push(l);
    }
  };

  const m2m: Link[] = [];
  for (const l of links) {
    if (l.cardinality === 'many-to-many') {
      const ex = m2m.find(
        (o) =>
          ((o.from === l.from && o.to === l.to) || (o.from === l.to && o.to === l.from)) &&
          // Same join table declared from both sides may be spelled differently (`user_roles` vs
          // `UserRoles`); treat names equal up to case/underscores/dashes as the same relation.
          (!o.throughName || !l.throughName || loose(o.throughName) === loose(l.throughName)),
      );
      if (ex) mergeInto(ex, l);
      else m2m.push(l);
    } else if (!l.fromColumns.length) pending.push(l);
    else add(l);
  }

  for (const l of pending) {
    const existing = out.filter((o) => o.from === l.from && o.to === l.to);
    if (existing.length === 1) {
      mergeInto(existing[0], l);
      continue;
    }
    const guessed = guessFkColumns(l.from, l.to, l.toColumns);
    if (guessed.length) {
      l.fromColumns = guessed;
      add(l);
    } else if (!existing.length) add(l);
  }
  return [...out, ...m2m];
}

/**
 * A foreign-key column set references exactly one table. When the same columns of an entity are
 * linked both to a defined entity and to an `external` placeholder (typically a target guessed from
 * a navigation name, e.g. EF Core `HasOne(x => x.Observer)` where `Observer` is a `Person`), the
 * placeholder link is merged into the real one (keeping details such as ON DELETE) and dropped.
 */
function preferRealTargets(links: Link[]): Link[] {
  const keyOf = (l: Link) => `${l.from.key}|${[...l.fromColumns].map(lower).sort().join(',')}`;
  const real = new Map<string, Link>();
  for (const l of links) {
    if (l.cardinality !== 'many-to-many' && l.fromColumns.length && !l.to.external) real.set(keyOf(l), l);
  }
  return links.filter((l) => {
    if (l.cardinality === 'many-to-many' || !l.fromColumns.length || !l.to.external) return true;
    const target = real.get(keyOf(l));
    if (!target) return true;
    const kind = target.kind;
    mergeInto(target, l);
    target.kind = KIND_STRENGTH[kind] >= KIND_STRENGTH[l.kind] ? kind : l.kind;
    return false;
  });
}

/** ORMs that create missing foreign-key columns themselves (shadow properties, join columns, auto FKs). */
const AUTO_FK_KINDS = new Set<SourceKind>(['typeorm', 'mikroorm', 'sequelize', 'jpa', 'efcore', 'doctrine', 'django', 'peewee', 'tortoise', 'ent']);

/**
 * Drops ORM associations whose foreign-key columns do not exist in a table with a complete column
 * list, for ORMs that never create such columns (e.g. a Rails `has_many :articles` inside `Article`
 * while `articles` has no `article_id`). Such code-level leftovers cannot work at runtime.
 */
function pruneDeadAssociations(links: Link[], warnings: ScanWarning[]): Link[] {
  return links.filter((l) => {
    if (l.kind !== 'orm' || l.cardinality === 'many-to-many' || !l.fromColumns.length) return true;
    if (!l.from.full || l.from.external || l.sources.some((k) => AUTO_FK_KINDS.has(k))) return true;
    const missing = l.fromColumns.filter((c) => !findColumnLoose(l.from.columns, c));
    if (!missing.length) return true;
    warnings.push({
      file: l.source?.file,
      line: l.source?.line,
      message: `Association not drawn: table "${l.from.name}" has no column ${missing.map((c) => `"${c}"`).join(', ')} (declared in the model, missing in the schema).`,
    });
    return false;
  });
}

function finishLinks(links: Link[]): void {
  for (const l of links) {
    if (l.cardinality === 'many-to-many') {
      l.optional = true;
      continue;
    }
    // Safety net: an association implies its FK column when the column list is not known, or when
    // the ORM creates missing FK columns itself (Sequelize, EF Core shadow properties, JPA join columns…).
    const implies = !l.from.full || (l.kind === 'orm' && l.sources.some((k) => AUTO_FK_KINDS.has(k)));
    if (implies && !l.from.external) {
      for (const [i, c] of l.fromColumns.entries()) {
        if (findColumnLoose(l.from.columns, c)) continue;
        const target = l.toColumns[i] ? findColumn(l.to.columns, l.toColumns[i]) : undefined;
        l.from.columns.push(column(c, target?.type ?? '', { nullable: l.explicitOptional ?? true }));
      }
    }
    const cols = l.fromColumns.map((c) => findColumn(l.from.columns, c)).filter((c): c is Column => !!c);
    if (l.cardinality === 'many-to-one' && cols.length && cols.length === l.fromColumns.length) {
      const pk = l.from.columns.filter((c) => c.primaryKey).map((c) => c.name);
      const unique =
        (pk.length > 0 && sameSet(pk, l.fromColumns)) ||
        (cols.length === 1 && cols[0].unique) ||
        l.from.indexes.some((ix) => ix.unique && sameSet(ix.columns, l.fromColumns));
      if (unique) l.cardinality = 'one-to-one';
    }
    l.optional = cols.length ? cols.some((c) => c.nullable && !c.primaryKey) : (l.explicitOptional ?? true);
    cols.forEach((c, i) => {
      if (c.references && !(c.references.inferred && l.kind !== 'inferred')) return;
      c.references = { entity: l.to.key, column: l.toColumns[i] ?? l.toColumns[0], ...(l.kind === 'inferred' ? { inferred: true } : {}) };
    });
  }
}

function idStem(name: string): string | undefined {
  const m = /^(.+?)_(?:id|ID|Id)$/.exec(name) ?? /^(.*[a-z0-9])(?:Id|ID)$/.exec(name);
  return m && m[1].length >= 2 ? m[1] : undefined;
}

function inferLinks(entities: WEntity[], links: Link[], linker: Linker): Link[] {
  const taken = new Map<WEntity, Set<string>>();
  for (const l of links) {
    if (l.cardinality === 'many-to-many') continue;
    let s = taken.get(l.from);
    if (!s) taken.set(l.from, (s = new Set()));
    for (const c of l.fromColumns) s.add(lower(c));
  }
  const out: Link[] = [];
  for (const e of entities) {
    if (e.external) continue;
    const used = taken.get(e);
    const pk = e.columns.filter((c) => c.primaryKey);
    for (const c of e.columns) {
      if (c.references || used?.has(lower(c.name))) continue;
      const stem = idStem(c.name);
      if (!stem) continue;
      if (findColumnLoose(e.columns, `${stem}_type`)) continue; // polymorphic association
      const doc = e.kind === 'collection';
      let target: WEntity | undefined;
      for (const n of new Set([pluralize(snakeCase(stem)), snakeCase(stem), pluralize(stem), stem])) {
        const t = linker.name(n, undefined, doc, e);
        if (t && !t.external && (t.kind === 'collection') === doc) {
          target = t;
          break;
        }
      }
      if (!target) {
        const t = linker.model(pascalCase(stem), e.sources[0] ?? 'sql', undefined, undefined, e);
        if (t && !t.external && (t.kind === 'collection') === doc) target = t;
      }
      if (!target || (target === e && c.primaryKey)) continue;
      const tpk = target.columns.filter((x) => x.primaryKey);
      const toCol = tpk.length === 1 ? tpk[0] : tpk.length === 0 ? (findColumn(target.columns, 'id') ?? findColumn(target.columns, '_id')) : undefined;
      if (!toCol || toCol === c) continue;
      const unique =
        c.unique ||
        (pk.length === 1 && pk[0] === c) ||
        e.indexes.some((ix) => ix.unique && ix.columns.length === 1 && same(ix.columns[0], c.name));
      out.push({
        from: e,
        to: target,
        fromColumns: [c.name],
        toColumns: [toCol.name],
        cardinality: unique ? 'one-to-one' : 'many-to-one',
        kind: 'inferred',
        sources: e.sources.slice(0, 1),
        source: c.source ?? e.primary,
      });
    }
  }
  return out;
}

const JOIN_EXTRA = /^(id|created_?at|updated_?at|inserted_?at|created_?on|updated_?on|date_?created|date_?updated|created|modified)$/i;

/** Marks pure junction tables and makes sure a many-to-many relation exists for each of them. */
function linkJoinTables(entities: WEntity[], links: Link[]): Link[] {
  const outgoing = new Map<WEntity, Link[]>();
  const incoming = new Set<WEntity>();
  for (const l of links) {
    if (l.cardinality === 'many-to-many') continue;
    push(outgoing, l.from, l);
    if (l.to !== l.from) incoming.add(l.to);
  }
  const added: Link[] = [];
  for (const e of entities) {
    if (e.external || e.kind !== 'table' || incoming.has(e) || !e.columns.length) continue;
    const outs = outgoing.get(e) ?? [];
    if (outs.length !== 2 || outs.some((l) => !l.fromColumns.length)) continue;
    const fk = new Set(outs.flatMap((l) => l.fromColumns.map(lower)));
    if (!e.columns.every((c) => fk.has(lower(c.name)) || JOIN_EXTRA.test(c.name))) continue;
    const [a, b] = outs;
    // Structure alone also matches e.g. posts(id, author_id, editor_id): require a composite key over
    // the FKs, no surrogate id, or a name that mentions both sides (post_tags, _CategoryToPost, UserRole).
    const pk = e.columns.filter((c) => c.primaryKey);
    const composite =
      (pk.length > 1 && pk.every((c) => fk.has(lower(c.name)))) ||
      e.indexes.some((ix) => ix.unique && ix.columns.length > 1 && ix.columns.every((c) => fk.has(lower(c))));
    const surrogate = e.columns.some((c) => !fk.has(lower(c.name)) && /^_?id$/i.test(c.name));
    const n = loose(e.name);
    const mentions = [a.to, b.to].every(
      (t) => n.includes(loose(singularize(t.name))) || t.models.some((m) => n.includes(loose(m.name))),
    );
    if (!composite && surrogate && !mentions) continue;
    e.joinTable = true;
    const pair = (l: Link) => (l.from === a.to && l.to === b.to) || (l.from === b.to && l.to === a.to);
    const existing = [...links, ...added].find(
      (l) =>
        l.cardinality === 'many-to-many' &&
        pair(l) &&
        (l.through === e || (l.throughName ? same(l.throughName, e.name) : !l.through)),
    );
    if (existing) {
      existing.through = e;
      existing.throughName = e.name;
      continue;
    }
    added.push({
      from: a.to,
      to: b.to,
      fromColumns: a.toColumns,
      toColumns: b.toColumns,
      cardinality: 'many-to-many',
      kind: KIND_STRENGTH[a.kind] <= KIND_STRENGTH[b.kind] ? a.kind : b.kind,
      through: e,
      throughName: e.name,
      optional: true,
      sources: [...e.sources],
      source: e.primary,
    });
  }
  return added;
}

function combineEnums(defs: Store, migs: Store): WEnum[] {
  const out = new Map<string, WEnum>(migs.enums);
  for (const [key, d] of defs.enums) {
    const m = out.get(key);
    if (m) for (const k of m.sources) addUnique(d.sources, k);
    out.set(key, d);
  }
  return [...out.values()];
}

function linkEnums(entities: WEntity[], enums: WEnum[]): void {
  if (!enums.length) {
    for (const e of entities) for (const c of e.columns) delete c.enumRef; // unresolved parser hints
    return;
  }
  const byName = new Map<string, WEnum[]>();
  for (const en of enums) {
    push(byName, lower(en.name), en);
    if (en.schema) push(byName, lower(`${en.schema}.${en.name}`), en);
  }
  const lookup = (raw: string) => {
    const t = raw.trim().replace(/\[\]$/, '').replace(/\?$/, '').replace(/["`[\]]/g, '').toLowerCase();
    return byName.get(t) ?? byName.get(t.split('.').pop() ?? t);
  };
  for (const e of entities) {
    for (const c of e.columns) {
      const hint = c.enumRef;
      delete c.enumRef;
      const cands = (hint ? lookup(hint) : undefined) ?? (c.type ? lookup(c.type) : undefined);
      if (!cands) continue;
      const pick = cands.find((en) => en.sources.some((k) => e.sources.includes(k))) ?? cands.find((en) => en.schema === e.schema) ?? cands[0];
      c.enumRef = pick.key;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// resolveSchema
// ─────────────────────────────────────────────────────────────────────────────────────────────

const byName = (a: { schema?: string; name: string }, b: { schema?: string; name: string }) =>
  naturalCompare(lower(a.schema ?? ''), lower(b.schema ?? '')) || naturalCompare(lower(a.name), lower(b.name));

/** Merges the parse results of all files into entities, relations and enums. */
export function resolveSchema(results: readonly FileResult[], options: ResolveOptions = {}): ResolvedSchema {
  const warnings: ScanWarning[] = [];
  const works = prepare(results, warnings);

  const defs = new Store('definition');
  const migs = new Store('migration');
  feedDefinitions(defs, works.filter((w) => w.origin === 'definition'));
  feedMigrations(migs, works.filter((w) => w.origin === 'migration'));

  const combined = combine(defs, migs);
  const dropped = new Set([...defs.dropped, ...migs.dropped].filter((k) => !combined.has(k)));
  const linker = new Linker(combined.values(), dropped);

  let links = linkAll([...defs.relations, ...migs.relations], linker, warnings);
  for (const l of links) canonicalize(l);
  links = dedupe(links);
  links = preferRealTargets(links);
  links = pruneDeadAssociations(links, warnings);
  finishLinks(links);

  const entities = linker.entities();
  if (options.inferRelations !== false) {
    const inferred = inferLinks(entities, links, linker);
    for (const l of inferred) canonicalize(l);
    finishLinks(inferred);
    links.push(...inferred);
  }
  links.push(...linkJoinTables(entities, links));

  const enums = combineEnums(defs, migs);
  linkEnums(entities, enums);

  // Output. Entities that only received partial, column-less contributions (e.g. `CREATE INDEX` or
  // `COMMENT ON` for a table defined nowhere) and take part in no relation are noise: drop them.
  const endpoints = new Set<WEntity>();
  for (const l of links) {
    endpoints.add(l.from);
    endpoints.add(l.to);
    if (l.through) endpoints.add(l.through);
  }
  const kept = entities.filter((e) =>
    e.external
      ? endpoints.has(e) // placeholders exist only for the relations pointing at them
      : e.createdIn !== undefined || e.columns.length > 0 || e.models.length > 0 || endpoints.has(e),
  );
  const outEntities: Entity[] = kept.map(toEntity);
  outEntities.sort((a, b) => Number(!!a.external) - Number(!!b.external) || byName(a, b) || (a.id < b.id ? -1 : 1));

  const ids = new Set<string>();
  const outRelations: Relation[] = links.map((l) => toRelation(l, ids));
  const nameOf = new Map(outEntities.map((e) => [e.id, e.name.toLowerCase()]));
  outRelations.sort(
    (a, b) =>
      naturalCompare(nameOf.get(a.from) ?? a.from, nameOf.get(b.from) ?? b.from) ||
      naturalCompare(nameOf.get(a.to) ?? a.to, nameOf.get(b.to) ?? b.to) ||
      naturalCompare(a.id, b.id),
  );

  const outEnums: EnumDef[] = enums
    .map((en) => ({
      id: en.key,
      name: en.name,
      ...(en.schema ? { schema: en.schema } : {}),
      values: en.values,
      sources: en.sources,
      ...(en.source ? { source: en.source } : {}),
    }))
    .sort(byName);

  return { entities: outEntities, relations: outRelations, enums: outEnums, warnings };
}

function toEntity(e: WEntity): Entity {
  const modelNames: string[] = [];
  const models = [...e.models].sort((a, b) => Number(!!a.child) - Number(!!b.child));
  for (const t of models) if (!modelNames.some((m) => same(m, t.name))) modelNames.push(t.name);
  const primaryFile = e.primary?.file;
  const files = [...e.files].sort((a, b) => Number(b === primaryFile) - Number(a === primaryFile) || naturalCompare(a, b));
  const out: Entity = {
    id: e.key,
    name: e.name,
    kind: e.kind,
    modelNames,
    columns: e.columns,
    indexes: e.indexes.filter((ix) => ix.columns.every((c) => findColumn(e.columns, c))),
    sources: e.sources,
    files,
  };
  if (e.schema) out.schema = e.schema;
  if (e.comment !== undefined) out.comment = e.comment;
  if (e.primary) out.source = e.primary;
  if (e.engine) out.engine = e.engine;
  if (e.group) out.group = e.group;
  if (e.external) out.external = true;
  if (e.joinTable) out.joinTable = true;
  return out;
}

function toRelation(l: Link, ids: Set<string>): Relation {
  const base =
    l.cardinality === 'many-to-many'
      ? `${l.from.key}<>${l.to.key}${l.throughName ? `@${lower(l.throughName)}` : ''}`
      : `${l.from.key}(${l.fromColumns.map(lower).join(',')})>${l.to.key}`;
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}#${n}`;
  ids.add(id);
  const out: Relation = {
    id,
    from: l.from.key,
    fromColumns: l.fromColumns,
    to: l.to.key,
    toColumns: l.toColumns,
    cardinality: l.cardinality,
    kind: l.kind,
    optional: l.optional ?? true,
    sources: l.sources,
  };
  if (l.name) out.name = l.name;
  if (l.onDelete) out.onDelete = l.onDelete;
  if (l.onUpdate) out.onUpdate = l.onUpdate;
  if (l.through) out.through = l.through.key;
  if (l.throughName) out.throughName = l.throughName;
  if (l.source) out.source = l.source;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// buildModel: resolveSchema + engines + source summaries
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildModelInput {
  workspaceName: string;
  results: readonly FileResult[];
  /** Engine hints found outside of parsers (docker compose, dependency manifests, env examples…). */
  engineHints?: readonly { file: string; hint: EngineHint }[];
  stats: ScanStats;
  warnings?: readonly ScanWarning[];
  inferRelations?: boolean;
  now?: Date;
}

const MAX_WARNINGS = 500;

export function buildModel(input: BuildModelInput): SchemaModel {
  const resolved = resolveSchema(input.results, { inferRelations: input.inferRelations });
  const engines = collectEngines(input.results, input.engineHints ?? [], resolved.entities);
  assignEngines(resolved.entities, engines);

  const warnings: ScanWarning[] = [...(input.warnings ?? [])];
  for (const r of input.results) {
    for (const w of r.result.warnings ?? []) warnings.push({ file: r.file, line: w.line, message: w.message });
  }
  warnings.push(...resolved.warnings);

  return {
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    workspaceName: input.workspaceName,
    entities: resolved.entities,
    relations: resolved.relations,
    enums: resolved.enums,
    engines,
    sources: summarizeSources(input.results, resolved.entities),
    warnings: warnings.slice(0, MAX_WARNINGS),
    stats: input.stats,
  };
}

function collectEngines(
  results: readonly FileResult[],
  extra: readonly { file: string; hint: EngineHint }[],
  entities: readonly Entity[],
): EngineInfo[] {
  const map = new Map<EngineId, EngineInfo>();
  const add = (file: string, h: EngineHint) => {
    const meta = ENGINES[h.engine];
    if (!meta) return;
    let info = map.get(h.engine);
    if (!info) map.set(h.engine, (info = { id: h.engine, label: meta.label, category: meta.category, evidence: [] }));
    if (!info.evidence.some((ev) => ev.file === file && ev.line === h.line && ev.detail === h.detail)) {
      info.evidence.push({ file, line: h.line, detail: h.detail });
    }
  };
  for (const r of results) for (const h of r.result.engines ?? []) add(r.file, h);
  for (const x of extra) add(x.file, x.hint);
  for (const e of entities) {
    if (e.engine && !map.has(e.engine) && e.source) {
      add(e.source.file, { engine: e.engine, line: e.source.line, detail: `${SOURCE_LABELS[e.sources[0]] ?? 'Schema'} model "${e.name}"` });
    }
  }
  const out = [...map.values()];
  for (const info of out) info.evidence.sort((a, b) => naturalCompare(a.file, b.file) || a.line - b.line);
  return out.sort((a, b) => b.evidence.length - a.evidence.length || a.label.localeCompare(b.label));
}

/** Entities without an engine get the workspace's only relational / document engine. */
function assignEngines(entities: Entity[], engines: readonly EngineInfo[]): void {
  const relational = engines.filter((e) => e.category === 'relational');
  const documents = engines.filter((e) => e.category === 'document');
  for (const e of entities) {
    if (e.engine) continue;
    if (e.kind === 'collection') {
      if (documents.length === 1) e.engine = documents[0].id;
    } else if (relational.length === 1) e.engine = relational[0].id;
  }
}

function hasContent(r: ParseResult): boolean {
  return !!(r.entities?.length || r.relations?.length || r.enums?.length || r.ops?.length);
}

function summarizeSources(results: readonly FileResult[], entities: readonly Entity[]): SourceSummary[] {
  const files = new Map<SourceKind, Set<string>>();
  for (const r of results) {
    if (!hasContent(r.result)) continue;
    let s = files.get(r.kind);
    if (!s) files.set(r.kind, (s = new Set()));
    s.add(r.file);
  }
  const counts = new Map<SourceKind, number>();
  for (const e of entities) {
    if (e.external) continue;
    for (const k of e.sources) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kinds = new Set<SourceKind>([...files.keys(), ...counts.keys()]);
  return [...kinds]
    .map((kind) => ({ kind, label: SOURCE_LABELS[kind] ?? kind, files: files.get(kind)?.size ?? 0, entities: counts.get(kind) ?? 0 }))
    .sort((a, b) => b.entities - a.entities || b.files - a.files || a.label.localeCompare(b.label));
}
