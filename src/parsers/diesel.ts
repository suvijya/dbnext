/**
 * Diesel parser (Rust). Reads the schema generated / written as `diesel::table! { … }` macros,
 * usually `src/schema.rs`.
 *
 * Handles: `[diesel::]table! { [use …;] [schema.]name (pk[, pk2]) { col -> Type, … } }`, the
 * `#[sql_name = "…"]` and `#[max_length = N]` column attributes, `Nullable<…>` / `Array<…>` wrappers,
 * doc comments, composite primary keys and `diesel::joinable!(child -> parent (fk));`.
 *
 * SeaORM (`DeriveEntityModel`) is a different technology handled by another parser; `detect`
 * deliberately requires the `table!` macro so SeaORM files are not claimed.
 */

import type { Column, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { cleanComment, Code } from '../core/text';
import { splitCsv } from './shared/schemas';

function detect(file: SourceFile): boolean {
  const t = file.text;
  return t.includes('table!') && t.includes('->');
}

function parse(file: SourceFile): ParseResult {
  const code = new Code(file.text, 'rust');
  const m = code.masked;
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };

  // ── table! { … } macros ──
  for (const macro of m.matchAll(/\btable\s*!\s*\{/g)) {
    const open = macro.index + macro[0].length - 1;
    const close = code.closing(open);
    if (close < 0) continue;
    parseTable(code, file, open + 1, close, result);
  }

  // ── joinable!(child -> parent (fk, …)); ──
  for (const j of m.matchAll(/\bjoinable\s*!\s*\(/g)) {
    const open = j.index + j[0].length - 1;
    const close = code.closing(open);
    if (close < 0) continue;
    const body = code.stripped.slice(open + 1, close);
    const jm = /^\s*([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)\s*\(\s*([^)]*)\)/.exec(body);
    if (!jm) continue;
    const fkCols = splitCsv(jm[3]);
    const rel: RawRelation = {
      from: { name: jm[1] },
      fromColumns: fkCols,
      to: { name: jm[2] },
      toColumns: [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      source: sourceRef(file, code.lineAt(j.index)),
    };
    result.relations.push(rel);
  }

  return result;
}

function parseTable(code: Code, file: SourceFile, start: number, end: number, result: ParseResult): void {
  const m = code.masked;
  // Table header: `[schema.]name (pk, …) {` — first such pattern after optional `use …;` lines.
  const headerRe = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)?)\s*\(([^)]*)\)\s*\{/g;
  headerRe.lastIndex = start;
  let header: RegExpExecArray | null = null;
  let hm: RegExpExecArray | null;
  while ((hm = headerRe.exec(m)) && hm.index < end) {
    header = hm;
    break;
  }
  if (!header || header.index >= end) return;

  const qualified = code.stripped.slice(header.index, header.index + header[1].length).trim();
  const parts = qualified.split('.').map((p) => p.trim());
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const pkCols = new Set(splitCsv(header[2]).map((c) => c.toLowerCase()));

  const bodyOpen = header.index + header[0].length - 1;
  const bodyClose = code.closing(bodyOpen);
  if (bodyClose < 0) return;

  const entity: RawEntity = {
    name,
    kind: 'table',
    ...(schema ? { schema } : {}),
    nameCertainty: 2,
    columns: [],
    source: sourceRef(file, code.lineAt(header.index)),
  };

  // Split the column block on top-level commas.
  for (const seg of code.split(bodyOpen + 1, bodyClose, ',')) {
    const col = parseColumn(code, file, seg.start, seg.end, pkCols);
    if (col) entity.columns.push(col);
  }
  result.entities.push(entity);
}

function parseColumn(code: Code, file: SourceFile, start: number, end: number, pkCols: Set<string>): Column | undefined {
  const stripped = code.stripped.slice(start, end);
  // `[#[attr …]]* name -> Type`
  const arrow = /([A-Za-z_]\w*)\s*->\s*([\s\S]+)$/.exec(stripped);
  if (!arrow) return undefined;
  const fieldName = arrow[1];
  let typeExpr = arrow[2].trim().replace(/,\s*$/, '');

  // Attributes before the field name.
  const attrs = code.stripped.slice(start, start + arrow.index);
  const sqlName = /#\s*\[\s*sql_name\s*=\s*"([^"]*)"\s*\]/.exec(attrs);
  const maxLen = /#\s*\[\s*max_length\s*=\s*(\d+)\s*\]/.exec(attrs);
  const name = sqlName ? sqlName[1] : fieldName;

  let nullable = false;
  let isArray = false;
  const nm = /^Nullable\s*<([\s\S]+)>$/.exec(typeExpr);
  if (nm) {
    nullable = true;
    typeExpr = nm[1].trim();
  }
  const am = /^Array\s*<([\s\S]+)>$/.exec(typeExpr);
  if (am) {
    isArray = true;
    typeExpr = am[1].trim();
  }
  const nm2 = /^Nullable\s*<([\s\S]+)>$/.exec(typeExpr);
  if (nm2) {
    nullable = true;
    typeExpr = nm2[1].trim();
  }

  let type = typeExpr.replace(/\s+/g, '');
  if (maxLen && /^(Var)?char$/i.test(type)) type = `${type}(${maxLen[1]})`;

  const primaryKey = pkCols.has(fieldName.toLowerCase());
  const props: Partial<Column> = {
    nullable: primaryKey ? false : nullable,
    primaryKey,
    source: sourceRef(file, code.lineAt(start)),
  };
  if (isArray) props.isArray = true;
  const comment = cleanComment(code.leadingComments(start).join('\n'));
  if (comment) props.comment = comment;
  return column(name, type, props);
}

export const dieselParser: SchemaParser = {
  kind: 'diesel',
  extensions: ['.rs'],
  detect,
  parse,
};
