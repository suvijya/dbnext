/**
 * Hibernate XML mapping parser (`*.hbm.xml`, root element `<hibernate-mapping>`).
 *
 * Handles: `<class table schema catalog>`, `<id>` / `<composite-id>` / `<version>`, `<property>`
 * (attributes or nested `<column>`), `<component>` / `<properties>` (flattened), `<many-to-one>`,
 * collections (`set bag list map array idbag`) with `<key>` + `<one-to-many>` / `<many-to-many>` /
 * `<element>`, `<joined-subclass>` / `<union-subclass>` (own table) and `<subclass>` (merged into the
 * parent table). Annotated JPA entities are handled by the JPA parser; `detect` only claims files that
 * contain a `<hibernate-mapping` element.
 */

import type { Column, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { shortName } from '../core/naming';
import { isTrue, kids, parseXml, type XmlNode } from './shared/xmltree';

const COLLECTIONS = new Set(['set', 'bag', 'list', 'map', 'array', 'primitive-array', 'idbag']);

function detect(file: SourceFile): boolean {
  return file.text.includes('<hibernate-mapping');
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const root = parseXml(file.text);
  for (const hm of root.children) {
    if (hm.name !== 'hibernate-mapping') continue;
    const ctx: Ctx = { file, result, schema: hm.attrs.schema, catalog: hm.attrs.catalog };
    for (const c of hm.children) {
      if (c.name === 'class' || c.name === 'subclass' || c.name === 'joined-subclass' || c.name === 'union-subclass') {
        classNode(ctx, c, undefined);
      }
    }
  }
  return result;
}

interface Ctx {
  file: SourceFile;
  result: ParseResult;
  schema?: string;
  catalog?: string;
}

function classNode(ctx: Ctx, node: XmlNode, parent: RawEntity | undefined): void {
  const className = node.attrs.name ? shortName(node.attrs.name) : undefined;
  if (!className) return;
  const isSub = node.name === 'subclass';
  let entity: RawEntity;
  if (isSub && parent) {
    entity = parent; // single-table inheritance: members go into the parent's table
  } else {
    const table = node.attrs.table || node.attrs.entity_name || className;
    entity = {
      name: unquote(table),
      kind: node.attrs.mutable === 'false' && !node.attrs.table ? 'view' : 'table',
      modelName: className,
      nameCertainty: node.attrs.table ? 2 : 0,
      columns: [],
      source: sourceRef(ctx.file, node.line),
    };
    const schema = node.attrs.schema ?? ctx.schema;
    if (schema) entity.schema = schema;
    if (node.attrs.abstract === 'true') entity.abstract = true;
    ctx.result.entities.push(entity);
  }
  const model = entity.modelName ?? className;
  const self = { name: entity.name, model };

  if ((node.name === 'joined-subclass') && parent) {
    const key = kids(node, 'key')[0];
    const keyCols = key ? columnNames(key, []) : [];
    for (const k of keyCols) entity.columns.push(column(k, '', { nullable: false, primaryKey: true, source: sourceRef(ctx.file, node.line) }));
    if (keyCols.length) {
      ctx.result.relations.push({
        from: self,
        fromColumns: keyCols,
        to: { name: parent.name, model: parent.modelName },
        toColumns: [],
        cardinality: 'one-to-one',
        kind: 'foreign-key',
        ...(key && key.attrs['on-delete'] === 'cascade' ? { onDelete: 'CASCADE' } : {}),
        source: sourceRef(ctx.file, node.line),
      });
    }
    entity.extends = [parent.modelName ?? shortName(node.attrs.extends ?? '')].filter(Boolean);
  } else if (node.name === 'union-subclass' && parent) {
    entity.extends = parent.modelName ? [parent.modelName] : [];
  }
  if (node.attrs.extends && !entity.extends) entity.extends = [shortName(node.attrs.extends)];

  members(ctx, entity, self, node);

  for (const sub of node.children) {
    if (sub.name === 'subclass' || sub.name === 'joined-subclass' || sub.name === 'union-subclass') classNode(ctx, sub, entity);
  }
}

type Self = { name: string; model: string };

/** Columns, relations and collections declared directly under `node` (recursing into components). */
function members(ctx: Ctx, entity: RawEntity, self: Self, node: XmlNode): void {
  const at = (n: XmlNode) => sourceRef(ctx.file, n.line);
  for (const c of node.children) {
    switch (c.name) {
      case 'id':
      case 'version':
      case 'timestamp': {
        const col = propertyColumn(ctx, c, c.name === 'id');
        if (c.name === 'id' && kids(c, 'generator').length) col.generated = kids(c, 'generator')[0].attrs.class !== 'assigned';
        if (c.name === 'id') col.nullable = false;
        entity.columns.push(col);
        break;
      }
      case 'composite-id':
        for (const k of c.children) {
          if (k.name === 'key-property') entity.columns.push({ ...propertyColumn(ctx, k, true), nullable: false });
          else if (k.name === 'key-many-to-one') {
            const cols = columnNames(k, [k.attrs.name ?? '']);
            cols.forEach((cn) => entity.columns.push(column(cn, '', { nullable: false, primaryKey: true, source: at(k) })));
            toOne(ctx, self, k, cols, false);
          }
        }
        break;
      case 'property':
        entity.columns.push(propertyColumn(ctx, c, false));
        break;
      case 'component':
      case 'properties':
      case 'dynamic-component':
      case 'nested-composite-element':
        members(ctx, entity, self, c);
        break;
      case 'many-to-one': {
        const cols = columnNames(c, [c.attrs.name ?? '']);
        const optional = !isTrue(c.attrs['not-null']) && !kids(c, 'column').some((x) => isTrue(x.attrs['not-null']));
        cols.forEach((cn) =>
          entity.columns.push(column(cn, '', { nullable: optional, unique: isTrue(c.attrs.unique), source: at(c) })),
        );
        toOne(ctx, self, c, cols, optional);
        break;
      }
      default:
        if (COLLECTIONS.has(c.name)) collection(ctx, self, c);
    }
  }
}

function toOne(ctx: Ctx, self: Self, node: XmlNode, cols: string[], optional: boolean): void {
  const target = node.attrs.class ?? node.attrs['entity-name'];
  if (!target || !cols.length || !cols[0]) return;
  const rel: RawRelation = {
    from: self,
    fromColumns: cols,
    to: { model: shortName(target) },
    toColumns: [],
    cardinality: isTrue(node.attrs.unique) ? 'one-to-one' : 'many-to-one',
    kind: 'orm',
    optional,
    navigation: node.attrs.name,
    source: sourceRef(ctx.file, node.line),
  };
  if (node.attrs['on-delete'] === 'cascade') rel.onDelete = 'CASCADE';
  ctx.result.relations.push(rel);
}

function collection(ctx: Ctx, self: Self, node: XmlNode): void {
  const key = kids(node, 'key')[0];
  const keyCols = key ? columnNames(key, []) : [];
  const at = sourceRef(ctx.file, node.line);
  const oneToMany = kids(node, 'one-to-many')[0];
  const manyToMany = kids(node, 'many-to-many')[0];
  const element = kids(node, 'element')[0];
  if (oneToMany?.attrs.class) {
    ctx.result.relations.push({
      from: self,
      fromColumns: [],
      to: { model: shortName(oneToMany.attrs.class) },
      toColumns: keyCols,
      cardinality: 'one-to-many',
      kind: 'orm',
      navigation: node.attrs.name,
      source: at,
    });
  } else if (manyToMany?.attrs.class && node.attrs.table) {
    ctx.result.relations.push({
      from: self,
      fromColumns: keyCols,
      to: { model: shortName(manyToMany.attrs.class) },
      toColumns: [],
      cardinality: 'many-to-many',
      kind: 'orm',
      through: { name: unquote(node.attrs.table) },
      navigation: node.attrs.name,
      source: at,
    });
  } else if (element && node.attrs.table && keyCols.length) {
    // Collection of values stored in its own table.
    const cols: Column[] = keyCols.map((k) => column(k, '', { nullable: false, source: at }));
    for (const cn of columnNames(element, [])) cols.push(column(cn, element.attrs.type ?? '', { source: at }));
    const entity: RawEntity = { name: unquote(node.attrs.table), kind: 'table', nameCertainty: 2, columns: cols, source: at };
    const schema = node.attrs.schema ?? ctx.schema;
    if (schema) entity.schema = schema;
    ctx.result.entities.push(entity);
    ctx.result.relations.push({
      from: { name: entity.name },
      fromColumns: keyCols,
      to: self,
      toColumns: [],
      cardinality: 'many-to-one',
      kind: 'orm',
      optional: false,
      navigation: node.attrs.name,
      source: at,
    });
  }
}

/** Column names from the `column` attribute or nested `<column name>` elements, else `fallback`. */
function columnNames(node: XmlNode, fallback: string[]): string[] {
  if (node.attrs.column) return node.attrs.column.split(',').map((s) => unquote(s.trim())).filter(Boolean);
  const nested = kids(node, 'column').map((c) => c.attrs.name).filter((s): s is string => !!s).map(unquote);
  return nested.length ? nested : fallback.filter(Boolean);
}

function propertyColumn(ctx: Ctx, node: XmlNode, primaryKey: boolean): Column {
  const nested = kids(node, 'column')[0];
  const name = columnNames(node, [node.attrs.name ?? ''])[0] ?? '';
  let type = nested?.attrs['sql-type'] ?? node.attrs.type ?? '';
  const length = nested?.attrs.length ?? node.attrs.length;
  if (length && !type.includes('(')) type = type ? `${type}(${length})` : `varchar(${length})`;
  const notNull = isTrue(node.attrs['not-null']) || isTrue(nested?.attrs['not-null']);
  const col = column(name, type, {
    nullable: !notNull && !primaryKey,
    primaryKey,
    unique: isTrue(node.attrs.unique) || isTrue(nested?.attrs.unique),
    source: sourceRef(ctx.file, node.line),
  });
  const def = nested?.attrs.default ?? node.attrs.default;
  if (def) col.default = def;
  return col;
}

/** Strips Hibernate's backtick / bracket identifier quoting. */
function unquote(s: string): string {
  return s.replace(/^[`"[]|[`"\]]$/g, '');
}

export const hibernateParser: SchemaParser = {
  kind: 'hibernate',
  extensions: ['.xml'],
  filePatterns: ['**/*.hbm.xml'],
  detect,
  parse,
};
