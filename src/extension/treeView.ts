import * as vscode from 'vscode';
import { columnKeys, columnType, entityKindLabel, enumSummary, qualifiedName, relationsByEntity, type EntityRelations } from '../core/format';
import {
  ENGINES,
  SOURCE_LABELS,
  type Column,
  type EngineEvidence,
  type EngineInfo,
  type Entity,
  type EnumDef,
  type Relation,
  type ScanWarning,
  type SchemaModel,
  type SourceRef,
} from '../core/model';

interface NodeBase {
  parent?: SchemaNode;
}
export interface GroupNode extends NodeBase {
  type: 'group';
  key: string;
  label: string;
  icon: string;
  description?: string;
  expanded: boolean;
  children: SchemaNode[];
}
export interface EntityNode extends NodeBase {
  type: 'entity';
  entity: Entity;
  /** Shown inside a schema group: label without the schema prefix. */
  short: boolean;
}
export interface ColumnNode extends NodeBase {
  type: 'column';
  entity: Entity;
  column: Column;
}
export interface RelationsNode extends NodeBase {
  type: 'relations';
  entity: Entity;
  relations: { relation: Relation; direction: 'out' | 'in' }[];
}
export interface RelationNode extends NodeBase {
  type: 'relation';
  entity: Entity;
  relation: Relation;
  direction: 'out' | 'in';
}
export interface EnumNode extends NodeBase {
  type: 'enum';
  en: EnumDef;
}
export interface EnumValueNode extends NodeBase {
  type: 'enumValue';
  en: EnumDef;
  value: string;
  index: number;
}
export interface EngineNode extends NodeBase {
  type: 'engine';
  engine: EngineInfo;
}
export interface EvidenceNode extends NodeBase {
  type: 'evidence';
  engine: EngineInfo;
  evidence: EngineEvidence;
  index: number;
}
export interface WarningNode extends NodeBase {
  type: 'warning';
  warning: ScanWarning;
  index: number;
}

export type SchemaNode =
  | GroupNode
  | EntityNode
  | ColumnNode
  | RelationsNode
  | RelationNode
  | EnumNode
  | EnumValueNode
  | EngineNode
  | EvidenceNode
  | WarningNode;

const NODE_TYPES = new Set(['group', 'entity', 'column', 'relations', 'relation', 'enum', 'enumValue', 'engine', 'evidence', 'warning']);

export function isSchemaNode(value: unknown): value is SchemaNode {
  return !!value && typeof value === 'object' && NODE_TYPES.has(String((value as { type?: unknown }).type));
}

/** Location to open for a tree node ("Go to Definition"). */
export function sourceOf(node: SchemaNode): SourceRef | undefined {
  switch (node.type) {
    case 'entity':
      return node.entity.source;
    case 'column':
      return node.column.source ?? node.entity.source;
    case 'relation':
      return node.relation.source ?? node.entity.source;
    case 'enum':
    case 'enumValue':
      return node.en.source;
    case 'evidence':
      return { file: node.evidence.file, line: node.evidence.line };
    case 'warning':
      return node.warning.file ? { file: node.warning.file, line: node.warning.line ?? 0 } : undefined;
    default:
      return undefined;
  }
}

const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;

/** Escapes Markdown so text from scanned files renders literally in tooltips. */
function esc(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function code(text: string): string {
  const t = text.replace(/`/g, "'").replace(/\s+/g, ' ');
  return `\`${t.length > 200 ? `${t.slice(0, 199)}…` : t}\``;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function entityIcon(e: Entity): string {
  if (e.external) return 'link-external';
  if (e.kind === 'view') return 'eye';
  if (e.kind === 'collection') return 'json';
  return e.joinTable ? 'link' : 'table';
}

function defaultSchemaLabel(items: readonly Entity[]): string {
  const engine = items.find((e) => e.engine)?.engine;
  if (engine === 'postgresql' || engine === 'cockroachdb') return 'public';
  if (engine === 'sqlserver') return 'dbo';
  return 'default schema';
}

export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SchemaNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: SchemaNode[] = [];
  private entities = new Map<string, Entity>();
  private enums = new Map<string, EnumDef>();
  private rels = new Map<string, EntityRelations>();
  private entityNodes = new Map<string, EntityNode>();
  private childCache = new WeakMap<SchemaNode, SchemaNode[]>();

  setModel(model: SchemaModel | undefined): void {
    this.entities = new Map(model?.entities.map((e) => [e.id, e]) ?? []);
    this.enums = new Map(model?.enums.map((e) => [e.id, e]) ?? []);
    this.rels = relationsByEntity(model?.relations ?? []);
    this.entityNodes = new Map();
    this.childCache = new WeakMap();
    this.roots = model ? this.buildRoots(model) : [];
    this.emitter.fire();
  }

  /** Tree node of an entity (for `TreeView.reveal`). */
  nodeForEntity(id: string): EntityNode | undefined {
    return this.entityNodes.get(id);
  }

  getParent(node: SchemaNode): SchemaNode | undefined {
    return node.parent;
  }

  getChildren(node?: SchemaNode): SchemaNode[] {
    if (!node) return this.roots;
    let list = this.childCache.get(node);
    if (!list) {
      list = this.computeChildren(node);
      this.childCache.set(node, list);
    }
    return list;
  }

  getTreeItem(node: SchemaNode): vscode.TreeItem {
    switch (node.type) {
      case 'group': {
        const item = new vscode.TreeItem(node.label, node.expanded ? Expanded : Collapsed);
        item.id = `group:${node.key}`;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = 'group';
        return item;
      }
      case 'entity':
        return this.entityItem(node);
      case 'column':
        return this.columnItem(node);
      case 'relations': {
        const item = new vscode.TreeItem('Relations', Collapsed);
        item.id = `relations:${node.entity.id}`;
        item.description = String(node.relations.length);
        item.iconPath = new vscode.ThemeIcon('type-hierarchy');
        item.contextValue = 'relations';
        return item;
      }
      case 'relation':
        return this.relationItem(node);
      case 'enum': {
        const en = node.en;
        const item = new vscode.TreeItem(en.schema ? `${en.schema}.${en.name}` : en.name, Collapsed);
        item.id = `enum:${en.id}`;
        item.description = plural(en.values.length, 'value');
        item.iconPath = new vscode.ThemeIcon('symbol-enum');
        item.contextValue = 'enum';
        item.tooltip = new vscode.MarkdownString(`**${esc(en.name)}** · enum\n\n${esc(enumSummary(en, 40))}`);
        return item;
      }
      case 'enumValue': {
        const item = new vscode.TreeItem(node.value, None);
        item.id = `enumValue:${node.en.id}:${node.index}`;
        item.iconPath = new vscode.ThemeIcon('symbol-enum-member');
        item.contextValue = 'enumValue';
        return item;
      }
      case 'engine': {
        const e = node.engine;
        const item = new vscode.TreeItem(e.label, Collapsed);
        item.id = `engine:${e.id}`;
        item.description = e.category;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'engine';
        item.tooltip = `${e.label} (${e.category} database), detected in ${plural(e.evidence.length, 'place')}. Expand to see where.`;
        return item;
      }
      case 'evidence': {
        const ev = node.evidence;
        const item = new vscode.TreeItem(ev.detail, None);
        item.id = `evidence:${node.engine.id}:${node.index}`;
        item.description = `${ev.file}:${ev.line + 1}`;
        item.iconPath = new vscode.ThemeIcon('go-to-file');
        item.contextValue = 'engineEvidence';
        item.command = { command: 'dbnext.openSource', title: 'Go to Definition', arguments: [{ file: ev.file, line: ev.line }] };
        return item;
      }
      case 'warning': {
        const w = node.warning;
        const item = new vscode.TreeItem(w.message.length > 100 ? `${w.message.slice(0, 99)}…` : w.message, None);
        item.id = `warning:${node.index}`;
        if (w.file) item.description = w.line !== undefined ? `${w.file}:${w.line + 1}` : w.file;
        item.tooltip = w.message;
        item.iconPath = new vscode.ThemeIcon('warning');
        item.contextValue = 'warning';
        const ref = sourceOf(node);
        if (ref) item.command = { command: 'dbnext.openSource', title: 'Open File', arguments: [ref] };
        return item;
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  // ── structure ──

  private buildRoots(model: SchemaModel): SchemaNode[] {
    if (!model.entities.length) return []; // lets the welcome view explain what to do
    const roots: SchemaNode[] = [];
    const group = (key: string, label: string, icon: string, expanded: boolean, count: number): GroupNode => ({
      type: 'group',
      key,
      label,
      icon,
      expanded,
      description: String(count),
      children: [],
    });

    if (model.engines.length) {
      const g = group('engines', 'Databases', 'database', true, model.engines.length);
      g.children = model.engines.map((engine): SchemaNode => ({ type: 'engine', engine, parent: g }));
      roots.push(g);
    }
    const defined = model.entities.filter((e) => !e.external);
    const kinds = [
      ['table', 'Tables', 'table'],
      ['view', 'Views', 'eye'],
      ['collection', 'Collections', 'json'],
    ] as const;
    for (const [kind, label, icon] of kinds) {
      const list = defined.filter((e) => e.kind === kind);
      if (list.length) roots.push(this.entityGroup(kind, label, icon, list));
    }
    const external = model.entities.filter((e) => e.external);
    if (external.length) {
      const g = group('external', 'Referenced, not defined here', 'link-external', false, external.length);
      g.children = external.map((e) => this.entityNode(e, g, false));
      roots.push(g);
    }
    if (model.enums.length) {
      const g = group('enums', 'Enums', 'symbol-enum', false, model.enums.length);
      g.children = model.enums.map((en): SchemaNode => ({ type: 'enum', en, parent: g }));
      roots.push(g);
    }
    if (model.warnings.length) {
      const g = group('warnings', 'Scan warnings', 'warning', false, model.warnings.length);
      g.children = model.warnings.map((warning, index): SchemaNode => ({ type: 'warning', warning, index, parent: g }));
      roots.push(g);
    }
    return roots;
  }

  private entityGroup(kind: string, label: string, icon: string, list: Entity[]): GroupNode {
    const g: GroupNode = { type: 'group', key: kind, label, icon, expanded: true, description: String(list.length), children: [] };
    const bySchema = new Map<string, Entity[]>();
    for (const e of list) {
      const key = e.schema ?? '';
      const items = bySchema.get(key);
      if (items) items.push(e);
      else bySchema.set(key, [e]);
    }
    if (bySchema.size < 2) {
      g.children = list.map((e) => this.entityNode(e, g, false));
      return g;
    }
    const schemas = [...bySchema.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    for (const [schema, items] of schemas) {
      const sg: GroupNode = {
        type: 'group',
        key: `${kind}:schema:${schema}`,
        label: schema || defaultSchemaLabel(items),
        icon: 'symbol-namespace',
        expanded: true,
        description: String(items.length),
        children: [],
        parent: g,
      };
      sg.children = items.map((e) => this.entityNode(e, sg, true));
      g.children.push(sg);
    }
    return g;
  }

  private entityNode(entity: Entity, parent: GroupNode, short: boolean): EntityNode {
    const node: EntityNode = { type: 'entity', entity, parent, short };
    this.entityNodes.set(entity.id, node);
    return node;
  }

  private computeChildren(node: SchemaNode): SchemaNode[] {
    switch (node.type) {
      case 'group':
        return node.children;
      case 'entity': {
        const e = node.entity;
        const out: SchemaNode[] = e.columns.map((column): SchemaNode => ({ type: 'column', entity: e, column, parent: node }));
        const r = this.rels.get(e.id);
        const relations = [
          ...(r?.outgoing ?? []).map((relation) => ({ relation, direction: 'out' as const })),
          ...(r?.incoming ?? []).map((relation) => ({ relation, direction: 'in' as const })),
        ];
        if (relations.length) out.push({ type: 'relations', entity: e, relations, parent: node });
        return out;
      }
      case 'relations':
        return node.relations.map(({ relation, direction }): SchemaNode => ({ type: 'relation', entity: node.entity, relation, direction, parent: node }));
      case 'enum':
        return node.en.values.map((value, index): SchemaNode => ({ type: 'enumValue', en: node.en, value, index, parent: node }));
      case 'engine':
        return node.engine.evidence.map((evidence, index): SchemaNode => ({ type: 'evidence', engine: node.engine, evidence, index, parent: node }));
      default:
        return [];
    }
  }

  // ── items ──

  private nameOf(id: string): string {
    const e = this.entities.get(id);
    return e ? qualifiedName(e) : id;
  }

  private entityItem(node: EntityNode): vscode.TreeItem {
    const e = node.entity;
    const item = new vscode.TreeItem(node.short ? e.name : qualifiedName(e), Collapsed);
    item.id = `entity:${e.id}`;
    const r = this.rels.get(e.id);
    const relCount = (r?.outgoing.length ?? 0) + (r?.incoming.length ?? 0);
    const parts: string[] = [];
    const models = e.modelNames.filter((m) => m.toLowerCase() !== e.name.toLowerCase());
    if (models.length) parts.push(models.join(', '));
    parts.push(e.external ? 'not defined in the workspace' : plural(e.columns.length, 'column'));
    if (relCount) parts.push(plural(relCount, 'relation'));
    item.description = parts.join(' · ');
    item.iconPath = new vscode.ThemeIcon(entityIcon(e));
    item.contextValue = e.external ? 'externalEntity' : 'entity';
    item.accessibilityInformation = { label: `${entityKindLabel(e)} ${qualifiedName(e)}, ${item.description}` };

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${esc(qualifiedName(e))}** · ${entityKindLabel(e)}\n\n`);
    if (e.comment) md.appendMarkdown(`${esc(e.comment)}\n\n`);
    const lines: string[] = [];
    if (e.modelNames.length) lines.push(`Model: ${e.modelNames.map(code).join(', ')}`);
    lines.push(`Source: ${e.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}`);
    if (e.engine) lines.push(`Database: ${ENGINES[e.engine]?.label ?? e.engine}`);
    if (e.source) lines.push(`Defined in ${code(`${e.source.file}:${e.source.line + 1}`)}`);
    if (e.files.length > 1) lines.push(`Also described in ${plural(e.files.length - 1, 'other file')}`);
    lines.push(`${plural(e.columns.length, 'column')} · ${plural(relCount, 'relation')}`);
    if (e.indexes.length) {
      const list = e.indexes.slice(0, 8).map((ix) => `(${ix.columns.map(esc).join(', ')})${ix.unique ? ' unique' : ''}`);
      lines.push(`Indexes: ${list.join('; ')}${e.indexes.length > 8 ? '; …' : ''}`);
    }
    md.appendMarkdown(lines.join('  \n'));
    item.tooltip = md;
    return item;
  }

  private columnItem(node: ColumnNode): vscode.TreeItem {
    const c = node.column;
    const item = new vscode.TreeItem(c.name, None);
    item.id = `column:${node.entity.id}:${c.name}`;
    const type = columnType(c);
    const nullable = c.nullable && !c.primaryKey;
    const keys = columnKeys(c);
    const parts: string[] = [];
    if (type) parts.push(nullable ? `${type}?` : type);
    if (keys.length) parts.push(keys.join(' '));
    const target = c.references ? `${this.nameOf(c.references.entity)}${c.references.column ? `.${c.references.column}` : ''}` : '';
    if (target) parts.push(`→ ${target}`);
    item.description = parts.join('  ');
    item.iconPath = new vscode.ThemeIcon(c.primaryKey ? 'key' : c.references ? 'references' : c.enumRef ? 'symbol-enum' : 'symbol-field');
    item.contextValue = 'column';

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${esc(c.name)}**${type ? ` ${code(type)}` : ''}\n\n`);
    const lines: string[] = [];
    if (c.primaryKey) lines.push('Primary key');
    if (c.unique && !c.primaryKey) lines.push('Unique');
    lines.push(nullable ? 'Nullable' : 'Required (not null)');
    if (c.generated) lines.push('Generated by the database / ORM');
    if (c.default !== undefined) lines.push(`Default: ${code(c.default)}`);
    if (target) lines.push(`References ${code(target)}${c.references?.inferred ? ' (inferred from the column name)' : ''}`);
    const en = c.enumRef ? this.enums.get(c.enumRef) : undefined;
    if (en) lines.push(`Enum ${code(en.name)}: ${esc(enumSummary(en))}`);
    if (c.comment) lines.push(esc(c.comment));
    md.appendMarkdown(lines.join('  \n'));
    item.tooltip = md;

    const ref = c.source ?? node.entity.source;
    if (ref) item.command = { command: 'dbnext.openSource', title: 'Go to Definition', arguments: [ref] };
    return item;
  }

  private relationItem(node: RelationNode): vscode.TreeItem {
    const r = node.relation;
    const self = node.entity.id;
    let other: string;
    let arrow: string;
    let icon: string;
    let detail: string;
    const cols = r.fromColumns.join(', ') || '?';
    if (r.cardinality === 'many-to-many') {
      other = r.from === self ? r.to : r.from;
      arrow = '↔';
      icon = 'arrow-swap';
      detail = r.throughName ? `via ${r.throughName} · many-to-many` : 'many-to-many';
    } else if (node.direction === 'out') {
      other = r.to;
      arrow = '→';
      icon = 'arrow-right';
      detail = `${cols} · ${r.cardinality}`;
    } else {
      other = r.from;
      arrow = '←';
      icon = 'arrow-left';
      detail = `${cols} · ${r.cardinality === 'one-to-one' ? 'one-to-one' : 'one-to-many'}`;
    }
    if (r.kind === 'inferred') detail += ' · inferred';
    const item = new vscode.TreeItem(`${arrow} ${this.nameOf(other)}`, None);
    item.id = `relation:${self}:${node.direction}:${r.id}`;
    item.description = detail;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = 'relation';
    const kind = r.kind === 'foreign-key' ? 'Foreign key' : r.kind === 'orm' ? 'ORM association' : 'Inferred from naming conventions';
    const lines = [`**${esc(this.nameOf(r.from))}** ${arrow === '↔' ? '↔' : '→'} **${esc(this.nameOf(r.to))}**`, `${kind} · ${r.cardinality}${r.optional ? ' · optional' : ''}`];
    if (r.cardinality !== 'many-to-many') lines.push(`${code(r.fromColumns.join(', ') || '?')} → ${code(r.toColumns.join(', ') || '?')}`);
    if (r.onDelete) lines.push(`On delete: ${esc(r.onDelete)}`);
    lines.push('Click to jump to the related table.');
    item.tooltip = new vscode.MarkdownString(lines.join('  \n'));
    item.command = { command: 'dbnext.revealEntity', title: 'Reveal Related Table', arguments: [other] };
    return item;
  }
}
