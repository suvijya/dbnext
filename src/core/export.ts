/**
 * Exporters: Mermaid `erDiagram` text and a Markdown "database map" document (which embeds the
 * diagram, so it renders on GitHub, GitLab, Azure DevOps and in Markdown previews with Mermaid).
 */

import { ENGINES, SOURCE_LABELS, type Column, type Entity, type Relation, type SchemaModel, type SourceRef } from './model';
import { columnKeys, columnType, enumSummary, qualifiedName, relationsByEntity, summaryText } from './format';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mermaid
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type MermaidColumns = 'all' | 'keys' | 'none';

export interface MermaidOptions {
  /** Which columns to list inside entities. `auto` (default) degrades to fit `maxLength`. */
  columns?: MermaidColumns | 'auto';
  /** Restrict the diagram to these entity ids. */
  entityIds?: readonly string[];
  /** Include relations inferred from naming conventions (drawn dashed). Default `true`. */
  inferred?: boolean;
  /** Include placeholder entities that are referenced but not defined. Default `true`. */
  external?: boolean;
  /** Text size budget for `auto` (Mermaid's default `maxTextSize` is 50 000). Default 45 000. */
  maxLength?: number;
}

type DiagramInput = Pick<SchemaModel, 'entities' | 'relations'>;

const PLAIN_ENTITY = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Mermaid erDiagram keywords. Used as a bare entity name they break the parser (`got 'END'`,
 * lexical errors…); quoted they are accepted. Verified against mermaid 11 and 12.
 */
const MERMAID_RESERVED = new Set([
  'end', 'style', 'classdef', 'class', 'erdiagram', 'subgraph', 'direction',
  'one', 'many', 'zero', 'to', 'or', 'only', 'optionally',
  'title', 'acctitle', 'accdescr', 'click',
]);

/** Entity name token: plain when safe, otherwise double-quoted (quotes, %, backslash and control chars removed). */
function entityToken(name: string): string {
  if (PLAIN_ENTITY.test(name) && !MERMAID_RESERVED.has(name.toLowerCase())) return name;
  const cleaned = name.replace(/["%\\\r\n\v\b]/g, '').trim() || 'entity';
  return `"${cleaned}"`;
}

/** Attribute type token: must start with a letter; letters, digits, `_`, `-`, `()`, `[]` only. */
export function mermaidType(type: string): string {
  let t = type
    .trim()
    .replace(/["'`]/g, '')
    .replace(/</g, '[')
    .replace(/>/g, ']')
    .replace(/\s*,\s*/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-()[\]]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!t) return 'unknown';
  if (!/^[A-Za-z]/.test(t)) t = `t_${t}`;
  if (/^[pfu]k$/i.test(t)) t = `t_${t}`; // PK/FK/UK are key markers, not valid attribute types
  return t;
}

/** Attribute name token: letters, digits, `_`, `-` only; may not start with a digit or `-`. */
export function mermaidName(name: string): string {
  let n = name.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  if (!n) return 'unnamed';
  if (!/^[A-Za-z_]/.test(n)) n = `_${n}`;
  if (/^[pfu]k$/i.test(n)) n = `${n}_`; // PK/FK/UK are key markers in Mermaid, not attribute names
  return n;
}

function mermaidComment(text: string, max = 80): string {
  const t = text.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function relationMarker(r: Relation): string {
  const line = r.kind === 'inferred' ? '..' : '--';
  if (r.cardinality === 'many-to-many') return `}o${line}o{`;
  const left = r.cardinality === 'one-to-one' ? '|o' : '}o';
  const right = r.optional ? 'o|' : '||';
  return `${left}${line}${right}`;
}

function renderMermaid(input: DiagramInput, options: MermaidOptions, columns: MermaidColumns): string {
  const wanted = options.entityIds ? new Set(options.entityIds) : undefined;
  const entities = input.entities.filter((e) => (!wanted || wanted.has(e.id)) && (options.external !== false || !e.external));
  const included = new Set(entities.map((e) => e.id));

  // Unique tokens even when different ids sanitize to the same name.
  const tokens = new Map<string, string>();
  const used = new Set<string>();
  for (const e of entities) {
    const base = entityToken(qualifiedName(e));
    let token = base;
    for (let n = 2; used.has(token.toLowerCase()); n++) {
      token = base.startsWith('"') ? `${base.slice(0, -1)} (${n})"` : `${base}_${n}`;
    }
    used.add(token.toLowerCase());
    tokens.set(e.id, token);
  }

  const lines = ['erDiagram'];
  for (const e of entities) {
    const token = tokens.get(e.id)!;
    const cols = columns === 'none' ? [] : columns === 'keys' ? e.columns.filter((c) => columnKeys(c).length) : e.columns;
    if (!cols.length) {
      lines.push(`    ${token}`);
      continue;
    }
    lines.push(`    ${token} {`);
    const seen = new Set<string>();
    for (const c of cols) {
      let name = mermaidName(c.name);
      for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${mermaidName(c.name)}_${n}`;
      seen.add(name.toLowerCase());
      const keys = columnKeys(c);
      const parts = [mermaidType(columnType(c) || 'unknown'), name];
      if (keys.length) parts.push(keys.join(', '));
      if (c.comment) parts.push(`"${mermaidComment(c.comment)}"`);
      lines.push(`        ${parts.join(' ')}`);
    }
    lines.push('    }');
  }

  for (const r of input.relations) {
    if (!included.has(r.from) || !included.has(r.to)) continue;
    if (r.kind === 'inferred' && options.inferred === false) continue;
    // A many-to-many through a join table that is drawn already shows up as two foreign keys.
    if (r.cardinality === 'many-to-many' && r.through && included.has(r.through)) continue;
    const label =
      r.cardinality === 'many-to-many'
        ? r.throughName
          ? `via ${r.throughName}`
          : 'many-to-many'
        : r.fromColumns.join(', ');
    lines.push(`    ${tokens.get(r.from)} ${relationMarker(r)} ${tokens.get(r.to)} : "${mermaidComment(label, 60)}"`);
  }
  return lines.join('\n');
}

/** Mermaid `erDiagram` source for the model (or a subset of it). */
export function toMermaid(input: DiagramInput, options: MermaidOptions = {}): string {
  const mode = options.columns ?? 'auto';
  if (mode !== 'auto') return renderMermaid(input, options, mode);
  const max = options.maxLength ?? 45_000;
  let text = '';
  for (const cols of ['all', 'keys', 'none'] as const) {
    text = renderMermaid(input, options, cols);
    if (text.length <= max) break;
  }
  return text;
}

/** Which column mode `auto` picks for this model (used to explain the choice in exports). */
export function autoMermaidColumns(input: DiagramInput, options: MermaidOptions = {}): MermaidColumns {
  const max = options.maxLength ?? 45_000;
  for (const cols of ['all', 'keys'] as const) if (renderMermaid(input, options, cols).length <= max) return cols;
  return 'none';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Markdown
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MarkdownOptions {
  /** Link for a source location relative to the exported file (e.g. `../prisma/schema.prisma#L12`). */
  fileLink?: (ref: SourceRef) => string | undefined;
  /** Marketplace / homepage link shown in the header. */
  generatorUrl?: string;
  mermaid?: MermaidOptions;
}

/** GitHub-compatible heading slugs, unique within one document. */
class Slugger {
  private readonly seen = new Map<string, number>();

  slug(text: string): string {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const n = this.seen.get(base);
    this.seen.set(base, (n ?? 0) + 1);
    return n === undefined ? base : `${base}-${n}`;
  }
}

function cell(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\r?\n/g, ' ');
}

function code(text: string | undefined): string {
  if (!text) return '';
  const t = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  const fence = t.includes('`') ? '``' : '`';
  const pad = fence.length > 1 || t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function location(ref: SourceRef | undefined, options: MarkdownOptions): string {
  if (!ref) return '';
  const label = code(`${ref.file}:${ref.line + 1}`);
  const href = options.fileLink?.(ref);
  return href ? `[${label}](${encodeHref(href)})` : label;
}

/**
 * Percent-encodes a Markdown file link. `encodeURI` escapes `%` and spaces but leaves `# ? ( )`,
 * and a literal `#` in a path silently breaks the link (it starts the fragment). The trailing
 * `#L<line>` anchor appended by the caller is preserved.
 */
function encodeHref(href: string): string {
  const anchor = /#L\d+$/.exec(href)?.[0] ?? '';
  const path = anchor ? href.slice(0, href.length - anchor.length) : href;
  return (
    encodeURI(path)
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29') + anchor
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function columnRow(c: Column, nameOf: (id: string) => string): string {
  const ref = c.references
    ? `${nameOf(c.references.entity)}${c.references.column ? `.${c.references.column}` : ''}${c.references.inferred ? ' (inferred)' : ''}`
    : '';
  const notes: string[] = [];
  if (c.generated) notes.push('generated');
  if (c.enumRef) notes.push(`enum ${nameOf(c.enumRef)}`);
  if (c.comment) notes.push(c.comment);
  return `| ${code(c.name)} | ${code(columnType(c))} | ${c.nullable && !c.primaryKey ? 'yes' : ''} | ${columnKeys(c).join(', ')} | ${code(c.default)} | ${cell(ref)} | ${cell(notes.join('; '))} |`;
}

/** Full Markdown document describing the model. */
export function toMarkdown(model: SchemaModel, options: MarkdownOptions = {}): string {
  const slugger = new Slugger();
  const out: string[] = [];
  const title = `Database map: ${model.workspaceName}`;
  slugger.slug(title);
  const byId = new Map(model.entities.map((e) => [e.id, e]));
  const enumById = new Map(model.enums.map((e) => [e.id, e]));
  const nameOf = (id: string) => {
    const e = byId.get(id);
    if (e) return qualifiedName(e);
    const en = enumById.get(id);
    return en ? (en.schema ? `${en.schema}.${en.name}` : en.name) : id;
  };
  const rels = relationsByEntity(model.relations);
  const defined = model.entities.filter((e) => !e.external);
  const external = model.entities.filter((e) => e.external);

  const generator = options.generatorUrl ? `[DBNext](${options.generatorUrl})` : 'DBNext';
  out.push(`# ${title}`, '');
  out.push(`> Generated by ${generator} on ${formatDate(model.generatedAt)} from the schema definitions in this repository. Re-export instead of editing by hand.`, '');
  out.push(`**${summaryText(model)}**`, '');
  if (model.engines.length) out.push(`**Databases:** ${model.engines.map((e) => e.label).join(', ')}`, '');
  if (model.sources.length) {
    const src = model.sources.map((s) => `${s.label} (${s.files} ${s.files === 1 ? 'file' : 'files'})`).join(', ');
    out.push(`**Detected from:** ${src}`, '');
  }

  if (!model.entities.length) {
    out.push('_No database schema was detected._', '');
    return out.join('\n');
  }

  // Diagram
  out.push(`## Diagram`, '');
  slugger.slug('Diagram');
  const mode = options.mermaid?.columns && options.mermaid.columns !== 'auto' ? options.mermaid.columns : autoMermaidColumns(model, options.mermaid);
  if (mode !== 'all') {
    out.push(
      mode === 'keys'
        ? '_The schema is large, so the diagram only lists key columns. All columns are listed below._'
        : '_The schema is large, so the diagram only shows tables and relations. Columns are listed below._',
      '',
    );
  }
  out.push('```mermaid', toMermaid(model, { ...options.mermaid, columns: mode }), '```', '');

  // Index
  const anchors = new Map<string, string>();
  out.push('## Tables', '');
  slugger.slug('Tables');
  out.push('| Name | Kind | Columns | Relations | Defined in |', '|---|---|---|---|---|');
  const pending: [Entity, string][] = [];
  for (const e of defined) {
    const heading = qualifiedName(e);
    const slug = slugger.slug(heading);
    anchors.set(e.id, slug);
    pending.push([e, heading]);
  }
  for (const [e] of pending) {
    const r = rels.get(e.id);
    const count = (r?.outgoing.length ?? 0) + (r?.incoming.length ?? 0);
    const kind = e.kind === 'table' ? (e.joinTable ? 'join table' : 'table') : e.kind;
    out.push(`| [${cell(qualifiedName(e))}](#${anchors.get(e.id)}) | ${kind} | ${e.columns.length} | ${count} | ${location(e.source, options)} |`);
  }
  out.push('');

  // Details
  for (const [e, heading] of pending) {
    out.push(`### ${heading}`, '');
    if (e.comment) out.push(cell(e.comment), '');
    const meta: string[] = [];
    if (e.modelNames.length) meta.push(`**Model:** ${e.modelNames.map(code).join(', ')}`);
    if (e.engine) meta.push(`**Engine:** ${ENGINES[e.engine]?.label ?? e.engine}`);
    meta.push(`**Source:** ${e.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}`);
    if (e.source) meta.push(`**Defined in:** ${location(e.source, options)}`);
    out.push(meta.join(' · '), '');
    if (e.columns.length) {
      out.push('| Column | Type | Nullable | Key | Default | References | Notes |', '|---|---|---|---|---|---|---|');
      for (const c of e.columns) out.push(columnRow(c, nameOf));
      out.push('');
    } else {
      out.push('_No columns are declared in the scanned files._', '');
    }
    if (e.indexes.length) {
      const list = e.indexes.map((ix) => `${ix.name ? `${code(ix.name)} ` : ''}(${ix.columns.map(code).join(', ')})${ix.unique ? ' unique' : ''}`);
      out.push(`**Indexes:** ${list.join('; ')}`, '');
    }
    const r = rels.get(e.id);
    const link = (id: string) => (anchors.has(id) ? `[${cell(nameOf(id))}](#${anchors.get(id)})` : cell(nameOf(id)));
    const outgoing = (r?.outgoing ?? []).filter((x) => x.cardinality !== 'many-to-many');
    if (outgoing.length) {
      const list = outgoing.map((x) => `${x.fromColumns.map(code).join(', ') || '?'} → ${link(x.to)}${x.kind === 'inferred' ? ' _(inferred)_' : ''}`);
      out.push(`**References:** ${list.join('; ')}`, '');
    }
    const incoming = r?.incoming ?? [];
    if (incoming.length) {
      out.push(`**Referenced by:** ${incoming.map((x) => `${link(x.from)}${x.fromColumns.length ? ` (${x.fromColumns.map(code).join(', ')})` : ''}`).join('; ')}`, '');
    }
    const m2m = (r?.outgoing ?? []).filter((x) => x.cardinality === 'many-to-many');
    if (m2m.length) {
      const list = m2m.map((x) => `${link(x.from === e.id ? x.to : x.from)}${x.throughName ? ` via ${x.through ? link(x.through) : code(x.throughName)}` : ''}`);
      out.push(`**Many-to-many:** ${list.join('; ')}`, '');
    }
  }

  if (external.length) {
    out.push('## Referenced but not defined here', '');
    slugger.slug('Referenced but not defined here');
    out.push('These tables are referenced by relations but defined outside the scanned files (framework tables, other services…).', '');
    for (const e of external) out.push(`- ${code(qualifiedName(e))}`);
    out.push('');
  }

  if (model.enums.length) {
    out.push('## Enums', '');
    slugger.slug('Enums');
    out.push('| Enum | Values | Defined in |', '|---|---|---|');
    for (const en of model.enums) {
      out.push(`| ${code(en.schema ? `${en.schema}.${en.name}` : en.name)} | ${cell(enumSummary(en, 30))} | ${location(en.source, options)} |`);
    }
    out.push('');
  }

  if (model.engines.length) {
    out.push('## Databases', '');
    slugger.slug('Databases');
    for (const eng of model.engines) {
      const ev = eng.evidence.slice(0, 5).map((x) => `${cell(x.detail)} (${location({ file: x.file, line: x.line }, options)})`);
      const more = eng.evidence.length > 5 ? `, +${eng.evidence.length - 5} more` : '';
      out.push(`- **${eng.label}** (${eng.category}): ${ev.join('; ')}${more}`);
    }
    out.push('');
  }

  const s = model.stats;
  out.push('---', '', `_Scanned ${s.filesRead.toLocaleString('en-US')} files in ${(s.durationMs / 1000).toFixed(1)} s${s.truncated ? ' (file limit reached; some files were skipped)' : ''}._`, '');
  return out.join('\n');
}


/**
 * Removes the lines of a {@link toMarkdown} document that change on every export (timestamp,
 * scan duration), so an automatic re-export only rewrites the file when the schema changed.
 */
export function stripVolatile(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('> Generated by ') && !line.startsWith('_Scanned '))
    .join('\n')
    .trim();
}
