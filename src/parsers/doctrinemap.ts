/**
 * Doctrine XML / YAML mapping parser (`*.dcm.xml`, `*.orm.xml`, `*.dcm.yml`, `*.orm.yml`, or any
 * XML / YAML file under a `doctrine/` directory that declares Doctrine mappings).
 *
 * XML: `<doctrine-mapping>` with `<entity>` / `<mapped-superclass>`, `<id>`, `<field>`,
 * `<many-to-one>` / `<one-to-one>` (+ `<join-column>`), `<many-to-many>` (+ `<join-table>`),
 * `<indexes>` and `<unique-constraints>`. YAML: the classic `Class: {type: entity, table, id, fields,
 * manyToOne, oneToOne, manyToMany, indexes, uniqueConstraints}` layout. Attribute-based mappings in PHP
 * are handled by the Doctrine parser; Liquibase / Hibernate XML files are never claimed.
 */

import type { Column, ParseResult, RawEntity, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, shortName } from '../core/naming';
import { splitCsv } from './shared/schemas';
import { child, childValue, parseYamlMap, type YamlNode } from './shared/miniyaml';
import { isTrue, kids, parseXml, type XmlNode } from './shared/xmltree';

const isXml = (path: string): boolean => path.toLowerCase().endsWith('.xml');

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (isXml(file.path)) return t.includes('<doctrine-mapping');
  if (t.includes('databaseChangeLog') || t.includes('<doctrine-mapping')) return false;
  return /^[ \t]+type:[ \t]*(entity|mappedSuperclass|embedded)\b/m.test(t) && /^["']?[\w\\]+["']?:[ \t]*(#.*)?\r?$/m.test(t);
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  if (isXml(file.path)) parseXmlFile(file, result);
  else parseYamlFile(file, result);
  return result;
}

// ── shared emit ──

interface Def {
  className: string;
  table?: string;
  schema?: string;
  abstract: boolean;
  line: number;
  columns: Column[];
  indexes: { name?: string; columns: string[]; unique: boolean }[];
  rels: Rel[];
}

interface Rel {
  kind: 'many-to-one' | 'one-to-one' | 'many-to-many' | 'one-to-many';
  field: string;
  target: string;
  mappedBy?: boolean;
  joinColumns: { name?: string; referenced?: string; nullable?: boolean; onDelete?: string }[];
  joinTable?: { name?: string; schema?: string; cols: string[]; inverseCols: string[] };
  line: number;
}

function emit(file: SourceFile, def: Def, result: ParseResult): void {
  const table = def.table ?? defaultTableName('doctrine', def.className);
  const entity: RawEntity = {
    name: table,
    kind: 'table',
    modelName: def.className,
    nameCertainty: def.table ? 2 : 0,
    columns: def.columns.map((c) => ({ ...c, source: sourceRef(file, c.source?.line ?? def.line) })),
    indexes: def.indexes.map((i) => ({ ...i, source: sourceRef(file, def.line) })),
    source: sourceRef(file, def.line),
  };
  if (def.schema) entity.schema = def.schema;
  if (def.abstract) entity.abstract = true;
  result.entities.push(entity);
  const self = { name: table, model: def.className };

  for (const r of def.rels) {
    const target = { model: shortName(r.target) };
    const source = sourceRef(file, r.line);
    if (r.kind === 'many-to-one' || r.kind === 'one-to-one') {
      const jcs = r.joinColumns.length ? r.joinColumns : [{}];
      const cols = jcs.map((j) => ('name' in j && j.name ? j.name : `${r.field}_id`));
      const optional = jcs.every((j) => !('nullable' in j) || j.nullable !== false);
      result.relations.push({
        from: self,
        fromColumns: cols,
        to: target,
        toColumns: jcs.map((j) => ('referenced' in j && j.referenced) || '').filter(Boolean),
        cardinality: r.kind,
        kind: 'orm',
        optional,
        navigation: r.field,
        ...(jcs[0] && 'onDelete' in jcs[0] && jcs[0].onDelete ? { onDelete: jcs[0].onDelete.toUpperCase() } : {}),
        source,
      });
    } else if (r.kind === 'many-to-many' && !r.mappedBy) {
      result.relations.push({
        from: self,
        fromColumns: r.joinTable?.cols ?? [],
        to: target,
        toColumns: [],
        cardinality: 'many-to-many',
        kind: 'orm',
        through: { name: r.joinTable?.name ?? `${table}_${defaultTableName('doctrine', shortName(r.target))}` },
        navigation: r.field,
        source,
      });
    }
    // Inverse sides (`mappedBy`, one-to-many) are declared by the owning side.
  }
}

function newDef(className: string, line: number): Def {
  return { className: shortName(className), abstract: false, line, columns: [], indexes: [], rels: [] };
}

function splitTable(def: Def, table: string | undefined, schema: string | undefined): void {
  if (table) {
    const parts = table.split('.');
    def.table = parts[parts.length - 1];
    if (parts.length > 1) def.schema = parts[parts.length - 2];
  }
  if (schema) def.schema = schema;
}

// ── XML ──

function parseXmlFile(file: SourceFile, result: ParseResult): void {
  const root = parseXml(file.text);
  for (const dm of root.children) {
    if (dm.name !== 'doctrine-mapping') continue;
    for (const e of dm.children) {
      if ((e.name !== 'entity' && e.name !== 'mapped-superclass' && e.name !== 'embeddable') || !e.attrs.name) continue;
      emit(file, xmlDef(e), result);
    }
  }
}

function xmlDef(e: XmlNode): Def {
  const def = newDef(e.attrs.name, e.line);
  splitTable(def, e.attrs.table, e.attrs.schema);
  def.abstract = e.name === 'mapped-superclass';
  for (const c of e.children) {
    if (c.name === 'id' || c.name === 'field') {
      const col = column(c.attrs.column || c.attrs.name || '', c.attrs.type ?? '', {
        primaryKey: c.name === 'id',
        nullable: c.name === 'id' ? false : isTrue(c.attrs.nullable),
        unique: isTrue(c.attrs.unique),
        source: { file: '', line: c.line },
      });
      if (c.attrs.length && col.type && !col.type.includes('(')) col.type += `(${c.attrs.length})`;
      if (kids(c, 'generator').length) col.generated = true;
      const d = kids(c, 'options')[0]?.children.find((o) => o.attrs.name === 'default');
      if (d && d.name === 'option') col.default = d.attrs.value ?? undefined;
      def.columns.push(col);
    } else if (c.name === 'indexes' || c.name === 'unique-constraints') {
      for (const i of kids(c, c.name === 'indexes' ? 'index' : 'unique-constraint')) {
        const cols = splitCsv(i.attrs.columns);
        if (cols.length) def.indexes.push({ ...(i.attrs.name ? { name: i.attrs.name } : {}), columns: cols, unique: c.name !== 'indexes' });
      }
    } else if (['many-to-one', 'one-to-one', 'many-to-many', 'one-to-many'].includes(c.name) && c.attrs.field && c.attrs['target-entity']) {
      const rel: Rel = {
        kind: c.name as Rel['kind'],
        field: c.attrs.field,
        target: c.attrs['target-entity'],
        mappedBy: !!c.attrs['mapped-by'],
        joinColumns: kids(c, 'join-column').map((j) => ({
          name: j.attrs.name,
          referenced: j.attrs['referenced-column-name'],
          nullable: j.attrs.nullable === undefined ? undefined : isTrue(j.attrs.nullable),
          onDelete: j.attrs['on-delete'],
        })),
        line: c.line,
      };
      const jt = kids(c, 'join-table')[0];
      if (jt) {
        const names = (tag: string) => kids(kids(jt, tag)[0] ?? jt, 'join-column').map((j) => j.attrs.name ?? '').filter(Boolean);
        rel.joinTable = { name: jt.attrs.name, schema: jt.attrs.schema, cols: names('join-columns'), inverseCols: names('inverse-join-columns') };
      }
      def.rels.push(rel);
    }
  }
  return def;
}

// ── YAML ──

function parseYamlFile(file: SourceFile, result: ParseResult): void {
  for (const top of parseYamlMap(file.text)) {
    const type = childValue(top, 'type');
    if (type !== 'entity' && type !== 'mappedSuperclass' && type !== 'embedded') continue;
    emit(file, yamlDef(top, type), result);
  }
}

function yamlDef(top: YamlNode, type: string): Def {
  const def = newDef(top.key, top.line);
  splitTable(def, childValue(top, 'table'), childValue(top, 'schema'));
  def.abstract = type === 'mappedSuperclass';
  const addColumns = (group: YamlNode | undefined, pk: boolean): void => {
    for (const f of group?.children ?? []) {
      const col = column(childValue(f, 'column') ?? f.key, f.value || childValue(f, 'type') || '', {
        primaryKey: pk,
        nullable: pk ? false : isTrue(childValue(f, 'nullable')),
        unique: isTrue(childValue(f, 'unique')),
        source: { file: '', line: f.line },
      });
      const len = childValue(f, 'length');
      if (len && col.type && !col.type.includes('(')) col.type += `(${len})`;
      if (pk && child(f, 'generator')) col.generated = true;
      def.columns.push(col);
    }
  };
  addColumns(child(top, 'id'), true);
  addColumns(child(top, 'fields'), false);

  for (const [group, constraint] of [['indexes', false], ['uniqueConstraints', true]] as const) {
    for (const i of child(top, group)?.children ?? []) {
      const cols = splitCsv((childValue(i, 'columns') ?? '').replace(/^\[|\]$/g, '').replace(/["']/g, ''));
      if (cols.length) def.indexes.push({ name: i.key, columns: cols, unique: constraint });
    }
  }

  for (const [group, kind] of [['manyToOne', 'many-to-one'], ['oneToOne', 'one-to-one'], ['manyToMany', 'many-to-many'], ['oneToMany', 'one-to-many']] as const) {
    for (const r of child(top, group)?.children ?? []) {
      const target = childValue(r, 'targetEntity');
      if (!target) continue;
      const jcNodes: YamlNode[] = [];
      const jc = child(r, 'joinColumn');
      if (jc) jcNodes.push(jc);
      for (const x of child(r, 'joinColumns')?.children ?? []) jcNodes.push(x);
      const rel: Rel = {
        kind,
        field: r.key,
        target,
        mappedBy: !!childValue(r, 'mappedBy'),
        joinColumns: jcNodes.map((j) => ({
          name: childValue(j, 'name') ?? (jc === j ? undefined : j.key),
          referenced: childValue(j, 'referencedColumnName'),
          nullable: childValue(j, 'nullable') === undefined ? undefined : isTrue(childValue(j, 'nullable')),
          onDelete: childValue(j, 'onDelete'),
        })),
        line: r.line,
      };
      const jt = child(r, 'joinTable');
      if (jt) {
        const names = (key: string) => (child(jt, key)?.children ?? []).map((j) => childValue(j, 'name') ?? j.key);
        rel.joinTable = { name: childValue(jt, 'name'), schema: childValue(jt, 'schema'), cols: names('joinColumns'), inverseCols: names('inverseJoinColumns') };
      }
      def.rels.push(rel);
    }
  }
  return def;
}

export const doctrinemapParser: SchemaParser = {
  kind: 'doctrinemap',
  extensions: ['.xml', '.yml', '.yaml'],
  filePatterns: ['**/*.dcm.{xml,yml,yaml}', '**/*.orm.{xml,yml,yaml}', '**/doctrine/**/*.{xml,yml,yaml}'],
  detect,
  parse,
};
