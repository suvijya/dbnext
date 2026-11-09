/**
 * Extra text exporters: DBML (round-trips through the repo's own DBML parser) and PlantUML
 * (`entity` blocks with crow's-foot relations). Pure functions, no Node APIs.
 */

import type { Column, Entity, Relation, SchemaModel } from './model';
import { qualifiedName } from './format';

type DiagramInput = Pick<SchemaModel, 'entities' | 'relations'> & Partial<Pick<SchemaModel, 'enums'>>;

export interface DiagramExportOptions {
  /** Restrict the output to these entity ids. */
  entityIds?: readonly string[];
  /** Include relations inferred from naming conventions. Default `true`. */
  inferred?: boolean;
}

function select(input: DiagramInput, options: DiagramExportOptions): { entities: Entity[]; relations: Relation[] } {
  const only = options.entityIds ? new Set(options.entityIds) : undefined;
  const entities = input.entities.filter((e) => !only || only.has(e.id));
  const ids = new Set(entities.map((e) => e.id));
  const relations = input.relations.filter(
    (r) => ids.has(r.from) && ids.has(r.to) && r.fromColumns.length > 0 && r.toColumns.length > 0 && (options.inferred !== false || r.kind !== 'inferred'),
  );
  return { entities, relations };
}

// ── DBML ──────────────────────────────────────────────────────────────────────

const DBML_SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DBML_TYPE = /^[A-Za-z_][A-Za-z0-9_.]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])?$/;

function dbmlIdent(name: string): string {
  return DBML_SIMPLE.test(name) ? name : `"${name.replace(/[\\"\r\n]/g, '_')}"`;
}

function dbmlTable(e: Pick<Entity, 'name' | 'schema'>): string {
  return e.schema ? `${dbmlIdent(e.schema)}.${dbmlIdent(e.name)}` : dbmlIdent(e.name);
}

function dbmlString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
}

function dbmlType(type: string): string {
  const t = type.trim() || 'unknown';
  return DBML_TYPE.test(t) ? t : `"${t.replace(/[\\"\r\n]/g, '_')}"`;
}

function dbmlColumn(c: Column): string {
  const settings: string[] = [];
  if (c.primaryKey) settings.push('pk');
  if (!c.nullable && !c.primaryKey) settings.push('not null');
  if (c.unique && !c.primaryKey) settings.push('unique');
  if (c.default !== undefined && c.default !== '') settings.push(`default: \`${c.default.replace(/[`\r\n]/g, ' ')}\``);
  if (c.comment) settings.push(`note: ${dbmlString(c.comment)}`);
  return `  ${dbmlIdent(c.name)} ${dbmlType(c.type)}${settings.length ? ` [${settings.join(', ')}]` : ''}`;
}

const DBML_OP: Record<Relation['cardinality'], string> = { 'many-to-one': '>', 'one-to-one': '-', 'many-to-many': '<>' };

function dbmlEndpoint(e: Entity, columns: string[]): string {
  const cols = columns.map(dbmlIdent);
  return `${dbmlTable(e)}.${cols.length === 1 ? cols[0] : `(${cols.join(', ')})`}`;
}

export function toDbml(input: DiagramInput, options: DiagramExportOptions = {}): string {
  const { entities, relations } = select(input, options);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const en of input.enums ?? []) {
    if (!en.values.length) continue;
    out.push(`Enum ${dbmlTable(en)} {`, ...en.values.map((v) => `  ${dbmlIdent(v)}`), '}', '');
  }
  for (const e of entities) {
    out.push(`Table ${dbmlTable(e)} {`);
    for (const c of e.columns) out.push(dbmlColumn(c));
    const idx = e.indexes.filter((i) => i.columns.length > 0);
    if (idx.length) {
      out.push('', '  indexes {');
      for (const i of idx) {
        const cols = i.columns.map(dbmlIdent);
        const s: string[] = [];
        if (i.unique) s.push('unique');
        if (i.name) s.push(`name: ${dbmlString(i.name)}`);
        out.push(`    ${cols.length === 1 ? cols[0] : `(${cols.join(', ')})`}${s.length ? ` [${s.join(', ')}]` : ''}`);
      }
      out.push('  }');
    }
    if (e.comment) out.push('', `  Note: ${dbmlString(e.comment)}`);
    out.push('}', '');
  }
  for (const r of relations) {
    const from = byId.get(r.from);
    const to = byId.get(r.to);
    if (!from || !to) continue;
    const s: string[] = [];
    if (r.onDelete) s.push(`delete: ${r.onDelete.toLowerCase()}`);
    if (r.onUpdate) s.push(`update: ${r.onUpdate.toLowerCase()}`);
    out.push(`Ref: ${dbmlEndpoint(from, r.fromColumns)} ${DBML_OP[r.cardinality]} ${dbmlEndpoint(to, r.toColumns)}${s.length ? ` [${s.join(', ')}]` : ''}`);
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ── PlantUML ──────────────────────────────────────────────────────────────────

function pumlText(text: string): string {
  return text.replace(/["\r\n{}]/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
}

function pumlRelation(r: Relation): string {
  const line = r.kind === 'inferred' ? '..' : '--';
  if (r.cardinality === 'many-to-many') return `}o${line}o{`;
  const one = r.optional ? '|o' : '||';
  return r.cardinality === 'one-to-one' ? `|o${line}${one}` : `}o${line}${one}`;
}

export function toPlantUml(input: DiagramInput, options: DiagramExportOptions = {}): string {
  const { entities, relations } = select(input, options);
  const alias = new Map(entities.map((e, i) => [e.id, `e${i + 1}`]));
  const out = ['@startuml', 'hide circle', 'skinparam linetype ortho', ''];
  for (const e of entities) {
    out.push(`entity "${pumlText(qualifiedName(e))}" as ${alias.get(e.id)} {`);
    const pk = e.columns.filter((c) => c.primaryKey);
    const rest = e.columns.filter((c) => !c.primaryKey);
    const line = (c: Column): string => {
      const marks = [c.primaryKey ? '<<PK>>' : '', c.references ? '<<FK>>' : ''].filter(Boolean).join(' ');
      return `  ${c.nullable || c.primaryKey ? '' : '* '}${pumlText(c.name)} : ${pumlText(c.type)}${marks ? ` ${marks}` : ''}`;
    };
    out.push(...pk.map(line));
    if (pk.length && rest.length) out.push('  --');
    out.push(...rest.map(line), '}', '');
  }
  for (const r of relations) {
    const label = r.fromColumns.map(pumlText).join(', ');
    out.push(`${alias.get(r.from)} ${pumlRelation(r)} ${alias.get(r.to)} : ${label}`);
  }
  out.push('@enduml');
  return `${out.join('\n')}\n`;
}
