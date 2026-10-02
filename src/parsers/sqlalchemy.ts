/**
 * SQLAlchemy parser: declarative models, Core `Table()` definitions and Alembic migrations.
 *
 * Declarative: `class User(Base | db.Model | DeclarativeBase subclass | mixins)` with
 * `__tablename__`, `__table_args__`, `__abstract__`, classic `Column(...)` and 2.0
 * `id: Mapped[int] = mapped_column(...)`, `ForeignKey('users.id')` and `relationship(..., secondary=…)`.
 * Core: `users = Table('users', metadata, Column(...), schema='s')`.
 * Alembic: `op.create_table / add_column / drop_column / alter_column / drop_table / rename_table /
 * create_foreign_key / drop_constraint / create_index`, including `with op.batch_alter_table(...)`.
 */

import type {
  Column,
  ColumnPatch,
  EntityRef,
  IndexDef,
  ParseResult,
  RawEntity,
  RawRelation,
  SchemaOp,
  SourceFile,
} from '../core/model';
import { emptyResult } from '../core/model';
import { column, type SchemaParser, sourceRef } from '../core/parser';
import { snakeCase } from '../core/naming';
import { Code, boolValue, stringValue } from '../core/text';
import {
  classMembers,
  docstring,
  findCalls,
  findClasses,
  firstParen,
  namedBool,
  namedString,
  namedText,
  annotationModel,
  type PyClass,
  type PyMember,
  positionalText,
  quotedList,
  splitFkTarget,
  tail,
  typeName,
  unwrapOptional,
} from './shared/python';

const COLUMN_CALLS = ['Column', 'mapped_column'];

export const sqlalchemyParser: SchemaParser = {
  kind: 'sqlalchemy',
  extensions: ['.py'],
  detect(file: SourceFile): boolean {
    const t = file.text;
    if (/from\s+sqlalchemy|import\s+sqlalchemy|from\s+flask_sqlalchemy|import\s+flask_sqlalchemy|from\s+alembic|import\s+alembic/.test(t)) return true;
    // Models that get Column / Model / db through a project module (`from app.database import Column, Model, db`).
    return /\b__tablename__\s*=/.test(t) && /\b(?:Column|mapped_column|reference_col)\s*\(/.test(t);
  },
  parse(file: SourceFile): ParseResult {
    const code = new Code(file.text, 'python');
    if (isAlembic(code)) return parseAlembic(code, file);
    return parseDefinitions(code, file);
  },
};

function isAlembic(code: Code): boolean {
  const m = code.masked;
  return /\bdef\s+upgrade\b/.test(m) && /\b(?:op|batch_op)\s*\.\s*(?:create_table|add_column|drop_column|alter_column|drop_table|rename_table|create_foreign_key|drop_constraint|create_index|create_unique_constraint|batch_alter_table|bulk_insert|execute)\b/.test(m);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Declarative + Core definitions
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseDefinitions(code: Code, file: SourceFile): ParseResult {
  const res = emptyResult('definition');
  const classes = findClasses(code);
  const byName = new Map<string, PyClass>();
  for (const c of classes) byName.set(c.name, c);

  const rootNames = new Set<string>(['Base', 'DeclarativeBase']);
  for (const mt of code.masked.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:[\w.]*\.)?(?:declarative_base|generate_base)\s*\(/g)) rootNames.add(mt[1]);
  for (const c of classes) if (c.baseNames.includes('DeclarativeBase')) rootNames.add(c.name);

  const reachesRoot = (c: PyClass, seen = new Set<string>()): boolean => {
    for (const base of c.bases) {
      const bn = tail(base);
      if (rootNames.has(bn) || bn === 'Model' || /(?:^|\.)Model$/.test(base.trim())) return true;
      const bc = byName.get(bn);
      if (bc && !seen.has(bn)) {
        seen.add(bn);
        if (reachesRoot(bc, seen)) return true;
      }
    }
    return false;
  };

  type Role = 'table' | 'abstract' | 'skip';
  const roles = new Map<PyClass, Role>();
  for (const c of classes) {
    if (c.name === 'Meta' || rootNames.has(c.name)) {
      roles.set(c, 'skip');
      continue;
    }
    if (c.kw.has('table') || c.baseNames.includes('SQLModel')) {
      roles.set(c, 'skip'); // belongs to the SQLModel parser
      continue;
    }
    const rr = reachesRoot(c);
    if (c.baseNames.includes('BaseModel') && !rr) {
      roles.set(c, 'skip'); // Pydantic
      continue;
    }
    const members = classMembers(code, c);
    const hasAbstract = members.some((m) => m.name === '__abstract__' && boolValue(m.valueText ?? '') === true);
    const hasTablename = members.some((m) => m.name === '__tablename__' || m.name === '__table__');
    const hasColumns = members.some((m) => isColumnMember(m));
    if (hasAbstract) roles.set(c, 'abstract');
    else if (rr && (hasTablename || hasColumns)) roles.set(c, 'table');
    else if (!rr && hasColumns) roles.set(c, 'abstract'); // mixin, possibly used as a base in other files
    else roles.set(c, 'skip');
  }
  const abstractNames = new Set<string>();
  for (const [c, role] of roles) if (role === 'abstract') abstractNames.add(c.name);

  // Core Table() definitions and their variable names (for `secondary=` lookup).
  const tableVars = new Map<string, string>();
  parseCoreTables(code, file, res, tableVars);

  for (const [c, role] of roles) {
    if (role === 'skip') continue;
    emitDeclarative(code, file, c, role === 'abstract', abstractNames, rootNames, tableVars, res);
  }
  return res;
}

function isColumnMember(m: PyMember): boolean {
  if (m.name.startsWith('__')) return false;
  if (m.callBase && COLUMN_CALLS.includes(m.callBase)) return true;
  if (m.callBase === 'reference_col') return true; // cookiecutter-flask helper: Column(ForeignKey('t.id'))
  if (m.callBase === 'relationship') return false;
  return !!m.annotation && /(?:^|\.)Mapped\s*\[/.test(m.annotation) && (!m.valueText || !/^relationship\b/.test(m.valueText));
}

function emitDeclarative(
  code: Code,
  file: SourceFile,
  c: PyClass,
  abstract: boolean,
  abstractNames: Set<string>,
  rootNames: Set<string>,
  tableVars: Map<string, string>,
  res: ParseResult,
): void {
  const members = classMembers(code, c);
  const columns: Column[] = [];
  const pkFromConstraint = new Set<string>();
  let tableName: string | undefined;
  let certainty: 0 | 1 | 2 = 0;
  let schema: string | undefined;
  const indexes: IndexDef[] = [];

  for (const mem of members) {
    if (mem.name === '__tablename__') {
      const v = stringValue(mem.valueText ?? '');
      if (v) {
        tableName = v;
        certainty = 2;
      } else if (mem.valueText && /__name__\s*\.\s*lower\s*\(\s*\)/.test(mem.valueText)) {
        tableName = c.name.toLowerCase();
        certainty = 1;
      }
      continue;
    }
    if (mem.name === '__table_args__' && mem.valueStart !== undefined) {
      const parsed = parseTableArgs(code, file, mem, c.name, columns, res);
      if (parsed.schema) schema = parsed.schema;
      indexes.push(...parsed.indexes);
      for (const p of parsed.pk) pkFromConstraint.add(p);
      continue;
    }
    if (mem.name.startsWith('__')) continue;

    if (mem.callBase === 'relationship') {
      const rel = relationshipToM2M(code, file, c.name, mem, tableVars);
      if (rel) res.relations.push(rel);
      continue;
    }
    if (!isColumnMember(mem)) continue;

    const col = buildDeclarativeColumn(code, file, c.name, mem, res);
    if (col) columns.push(col);
  }

  for (const name of pkFromConstraint) {
    const col = columns.find((x) => x.name === name);
    if (col) {
      col.primaryKey = true;
      col.nullable = false;
    }
  }

  if (!tableName) {
    tableName = snakeCase(c.name);
    certainty = 0;
  }
  const entity: RawEntity = {
    name: tableName,
    kind: 'table',
    modelName: c.name,
    nameCertainty: certainty,
    columns,
    source: sourceRef(file, c.line),
  };
  if (schema) entity.schema = schema;
  if (abstract) entity.abstract = true;
  // Abstract bases plus any other non-root base: mixins may be defined in other modules, and the
  // resolver only copies columns from bases that turn out to be abstract.
  const extendsBases = c.baseNames.filter((b) => abstractNames.has(b) || (!rootNames.has(b) && !NON_MODEL_BASES.has(b)));
  if (extendsBases.length) entity.extends = extendsBases;
  if (indexes.length) entity.indexes = indexes;
  const comment = docstring(code, c);
  if (comment) entity.comment = comment;
  res.entities.push(entity);
}

interface ParsedColumn {
  name?: string;
  type: string;
  nullable?: boolean;
  primaryKey: boolean;
  unique: boolean;
  index: boolean;
  default?: string;
  comment?: string;
  generated?: boolean;
  fk?: { ref: EntityRef; onDelete?: string; onUpdate?: string };
  enum?: { name: string; values: string[] };
}

/** Base class names that are never mixins with columns. */
const NON_MODEL_BASES = new Set(['Model', 'object', 'Base', 'DeclarativeBase', 'Generic', 'ABC']);

/**
 * `reference_col('users', nullable=False, pk_name='id')` – the cookiecutter-flask helper that returns
 * `Column(ForeignKey('users.id'), nullable=nullable)`. Note its default is NOT NULL.
 */
function parseReferenceCol(code: Code, open: number): ParsedColumn {
  const args = code.args(open);
  const table = stringValue(args.positional[0]?.text ?? '') ?? stringValue(args.named.get('tablename')?.text ?? '');
  const pk = stringValue(args.positional[2]?.text ?? args.named.get('pk_name')?.text ?? '') ?? 'id';
  const nullableText = args.positional[1]?.text ?? args.named.get('nullable')?.text;
  const nullable = nullableText !== undefined ? boolValue(nullableText) ?? false : false;
  const out: ParsedColumn = { type: '', nullable, primaryKey: false, unique: false, index: false };
  if (table) out.fk = { ref: { name: table }, col: pk } as ParsedColumn['fk'];
  return out;
}

/** Parses a `Column(...)` / `mapped_column(...)` / `sa.Column(...)` call at `open` (the `(`). */
function parseColumnCall(code: Code, open: number): ParsedColumn {
  const args = code.args(open);
  const positional = args.positional;
  let name: string | undefined;
  let typeIdx = 0;
  if (positional.length) {
    const first = stringValue(positional[0].text);
    if (first !== undefined) {
      name = first;
      typeIdx = 1;
    }
  }
  // Type = first non-ForeignKey/Constraint positional at typeIdx.
  let type = '';
  let typeStart = -1;
  let typeEnd = -1;
  let typeText = '';
  for (let i = typeIdx; i < positional.length; i++) {
    const t = positional[i].text;
    if (/^(?:\w+\.)*(?:ForeignKey|ForeignKeyConstraint|PrimaryKeyConstraint|UniqueConstraint|CheckConstraint|Index|Computed|Identity|Sequence)\b/.test(t)) continue;
    type = typeName(t);
    typeText = t;
    typeStart = positional[i].start;
    typeEnd = positional[i].end;
    break;
  }
  const parsed: ParsedColumn = {
    name,
    type,
    primaryKey: namedBool(args, 'primary_key') === true,
    unique: namedBool(args, 'unique') === true,
    index: namedBool(args, 'index') === true,
  };
  const nn = namedBool(args, 'nullable');
  if (nn !== undefined) parsed.nullable = nn;
  if (namedBool(args, 'autoincrement') === true) parsed.generated = true;
  const def = namedText(args, 'default') ?? namedText(args, 'server_default');
  if (def !== undefined) parsed.default = def;
  const comment = namedString(args, 'comment');
  if (comment !== undefined) parsed.comment = comment;

  // Enum("a","b", name="…") / postgresql.ENUM(…, name="…") type.
  if (typeStart >= 0 && /^(?:\w+\.)*(?:Enum|ENUM)\s*\(/.test(typeText)) {
    const eopen = firstParen(code, typeStart, typeEnd);
    if (eopen >= 0) {
      const ea = code.args(eopen);
      const ename = namedString(ea, 'name');
      const values: string[] = [];
      for (const sp of ea.positional) {
        const v = stringValue(sp.text);
        if (v !== undefined) values.push(v);
      }
      if (ename && values.length) {
        parsed.enum = { name: ename, values };
        parsed.type = ename;
      }
    }
  }

  // ForeignKey anywhere in the positional args.
  for (const fk of findCalls(code, open + 1, code.closing(open) < 0 ? code.text.length : code.closing(open), ['ForeignKey'])) {
    const fkArgs = code.args(fk.open);
    const targetStr = stringValue(positionalText(fkArgs, 0) ?? '') ?? positionalText(fkArgs, 0);
    if (!targetStr) continue;
    const t = splitFkTarget(targetStr);
    parsed.fk = { ref: { name: t.table, ...(t.schema ? { schema: t.schema } : {}) }, ...fkActions(fkArgs) };
    if (t.column) (parsed.fk as { ref: EntityRef; onDelete?: string; onUpdate?: string; col?: string }).col = t.column;
    break;
  }
  return parsed;
}

/** Pushes a column enum (deduplicated by name) and returns its name. */
function applyEnum(parsed: ParsedColumn, col: Column, res: ParseResult, file: SourceFile, line: number): void {
  if (!parsed.enum) return;
  col.enumRef = parsed.enum.name;
  col.type = parsed.enum.name;
  if (!res.enums.some((e) => e.name === parsed.enum!.name)) {
    res.enums.push({ name: parsed.enum.name, values: parsed.enum.values, source: sourceRef(file, line) });
  }
}

function fkActions(args: ReturnType<Code['args']>): { onDelete?: string; onUpdate?: string } {
  const out: { onDelete?: string; onUpdate?: string } = {};
  const od = namedString(args, 'ondelete');
  const ou = namedString(args, 'onupdate');
  if (od) out.onDelete = od.toUpperCase();
  if (ou) out.onUpdate = ou.toUpperCase();
  return out;
}

function buildDeclarativeColumn(code: Code, file: SourceFile, model: string, mem: PyMember, res: ParseResult): Column | undefined {
  const ann = unwrapOptional(mem.annotation);
  let parsed: ParsedColumn | undefined;
  if (mem.callOpen !== undefined && mem.callBase && COLUMN_CALLS.includes(mem.callBase)) parsed = parseColumnCall(code, mem.callOpen);
  else if (mem.callOpen !== undefined && mem.callBase === 'reference_col') parsed = parseReferenceCol(code, mem.callOpen);
  const name = parsed?.name ?? mem.name;
  const type = parsed?.type || (ann.type && ann.type !== 'None' ? ann.type : '');
  const primaryKey = parsed?.primaryKey ?? false;
  let nullable: boolean;
  if (parsed?.nullable !== undefined) nullable = parsed.nullable;
  else if (primaryKey) nullable = false;
  else if (mem.annotation) nullable = ann.optional;
  else nullable = true;
  const col = column(name, type, {
    nullable,
    primaryKey,
    unique: parsed?.unique ?? false,
    source: sourceRef(file, mem.line),
  });
  if (primaryKey) col.nullable = false;
  if (parsed?.generated) col.generated = true;
  if (parsed?.default !== undefined) col.default = parsed.default;
  if (parsed?.comment !== undefined) col.comment = parsed.comment;
  if (parsed) applyEnum(parsed, col, res, file, mem.line);

  if (parsed?.fk) {
    const fkCol = (parsed.fk as { col?: string }).col;
    res.relations.push({
      from: { model },
      fromColumns: [name],
      to: parsed.fk.ref,
      toColumns: fkCol ? [fkCol] : [],
      cardinality: 'many-to-one',
      kind: 'foreign-key',
      optional: nullable,
      ...(parsed.fk.onDelete ? { onDelete: parsed.fk.onDelete } : {}),
      ...(parsed.fk.onUpdate ? { onUpdate: parsed.fk.onUpdate } : {}),
      source: sourceRef(file, mem.line),
    });
  }
  if (parsed?.index && !col.unique) {
    // single-column index is informative but not required; skip to keep output lean
  }
  return col;
}

function relationshipToM2M(code: Code, file: SourceFile, model: string, mem: PyMember, tableVars: Map<string, string>): RawRelation | undefined {
  if (mem.callOpen === undefined) return undefined;
  const args = code.args(mem.callOpen);
  const secondary = namedText(args, 'secondary');
  if (!secondary) return undefined; // plain association – the FK column already covers it
  const targetExpr = positionalText(args, 0);
  let targetModel: string | undefined;
  if (targetExpr) targetModel = stringValue(targetExpr) ?? tail(targetExpr);
  if (!targetModel && mem.annotation) {
    targetModel = annotationModel(mem.annotation);
  }
  if (!targetModel) return undefined;
  const secStr = stringValue(secondary);
  const throughName = secStr ?? tableVars.get(secondary.trim()) ?? tableVars.get(tail(secondary));
  const through: EntityRef = throughName ? { name: throughName } : { name: tail(secondary) };
  return {
    from: { model },
    fromColumns: [],
    to: { model: targetModel },
    toColumns: [],
    cardinality: 'many-to-many',
    kind: 'orm',
    through,
    source: sourceRef(file, mem.line),
  };
}

interface TableArgs {
  schema?: string;
  indexes: IndexDef[];
  pk: string[];
}

function parseTableArgs(code: Code, file: SourceFile, mem: PyMember, model: string, columns: Column[], res: ParseResult): TableArgs {
  const out: TableArgs = { indexes: [], pk: [] };
  const start = mem.valueStart!;
  const end = mem.end;
  const schemaMatch = /['"]schema['"]\s*:\s*['"]([^'"]+)['"]/.exec(code.slice(start, end));
  if (schemaMatch) out.schema = schemaMatch[1];

  for (const call of findCalls(code, start, end, ['UniqueConstraint', 'PrimaryKeyConstraint', 'Index', 'ForeignKeyConstraint'])) {
    const a = code.args(call.open);
    if (call.base === 'UniqueConstraint') {
      const cols = quotedList(a.positional.map((p) => p.text).join(','));
      if (cols.length) {
        const ix: IndexDef = { columns: cols, unique: true };
        const nm = namedString(a, 'name');
        if (nm) ix.name = nm;
        out.indexes.push(ix);
      }
    } else if (call.base === 'PrimaryKeyConstraint') {
      out.pk.push(...quotedList(a.positional.map((p) => p.text).join(',')));
    } else if (call.base === 'Index') {
      const all = quotedList(a.positional.map((p) => p.text).join(','));
      if (all.length) {
        const name = all[0];
        const cols = all.slice(1);
        if (cols.length) out.indexes.push({ name, columns: cols, unique: namedBool(a, 'unique') === true });
      }
    } else if (call.base === 'ForeignKeyConstraint') {
      const localCols = quotedList(positionalText(a, 0) ?? '');
      const refs = quotedList(positionalText(a, 1) ?? '');
      if (localCols.length && refs.length) {
        const t = splitFkTarget(refs[0]);
        res.relations.push({
          from: { model },
          fromColumns: localCols,
          to: { name: t.table, ...(t.schema ? { schema: t.schema } : {}) },
          toColumns: refs.map((r) => splitFkTarget(r).column ?? '').filter(Boolean),
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          optional: localCols.every((lc) => columns.find((col) => col.name === lc)?.nullable ?? true),
          ...fkActions(a),
          source: sourceRef(file, mem.line),
        });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Core Table() definitions
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseCoreTables(code: Code, file: SourceFile, res: ParseResult, tableVars: Map<string, string>): void {
  const m = code.masked;
  for (const mt of m.matchAll(/(^|\n)[ \t]*([A-Za-z_]\w*)\s*=\s*((?:[\w.]*\.)?Table)\s*\(/g)) {
    const open = mt.index + mt[0].length - 1;
    const varName = mt[2];
    const args = code.args(open);
    const name = stringValue(positionalText(args, 0) ?? '');
    if (!name) continue;
    tableVars.set(varName, name);
    const schema = namedString(args, 'schema');
    const line = code.lineAt(mt.index + (mt[1] ? 1 : 0));
    const columns: Column[] = [];
    for (let i = 1; i < args.positional.length; i++) {
      const sp = args.positional[i];
      if (!/^(?:\w+\.)*Column\s*\(/.test(sp.text)) continue;
      const colOpen = firstParen(code, sp.start, sp.end);
      if (colOpen < 0) continue;
      const parsed = parseColumnCall(code, colOpen);
      if (!parsed.name) continue;
      const col = column(parsed.name, parsed.type, {
        nullable: parsed.nullable ?? !parsed.primaryKey,
        primaryKey: parsed.primaryKey,
        unique: parsed.unique,
        source: sourceRef(file, code.lineAt(sp.start)),
      });
      if (parsed.generated) col.generated = true;
      if (parsed.default !== undefined) col.default = parsed.default;
      if (parsed.comment !== undefined) col.comment = parsed.comment;
      applyEnum(parsed, col, res, file, code.lineAt(sp.start));
      columns.push(col);
      if (parsed.fk) {
        const fkCol = (parsed.fk as { col?: string }).col;
        res.relations.push({
          from: { name },
          fromColumns: [parsed.name],
          to: parsed.fk.ref,
          toColumns: fkCol ? [fkCol] : [],
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          optional: col.nullable,
          ...(parsed.fk.onDelete ? { onDelete: parsed.fk.onDelete } : {}),
          source: sourceRef(file, code.lineAt(sp.start)),
        });
      }
    }
    const entity: RawEntity = { name, kind: 'table', nameCertainty: 2, columns, source: sourceRef(file, line) };
    if (schema) entity.schema = schema;
    res.entities.push(entity);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Alembic migrations
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseAlembic(code: Code, file: SourceFile): ParseResult {
  const res = emptyResult('migration');
  const strip = code.stripped;

  const revMatch = /(^|\n)\s*revision(?:\s*:\s*[\w.\[\]'"| ]+)?\s*=\s*([^\n#]+)/.exec(strip);
  const id = revMatch ? stringValue(revMatch[2].trim()) : undefined;
  if (id) {
    const after: string[] = [];
    const downMatch = /(^|\n)\s*down_revision(?:\s*:\s*[\w.\[\]'"| ]+)?\s*=\s*([^\n#]+)/.exec(strip);
    if (downMatch) {
      const expr = downMatch[2].trim();
      if (!/^None\b/.test(expr)) {
        for (const q of quotedList(expr)) after.push(q);
        const single = stringValue(expr);
        if (single && !after.includes(single)) after.push(single);
      }
    }
    res.migration = { id, after };
  }

  const up = findUpgrade(code);
  if (!up) return res;

  // Batch contexts: `with op.batch_alter_table('t') as batch_op:` → table name per block range.
  const batches: { table: string; start: number; end: number }[] = [];
  for (const b of findCalls(code, up.start, up.end, ['batch_alter_table'])) {
    const bArgs = code.args(b.open);
    const t = stringValue(positionalText(bArgs, 0) ?? '');
    if (!t) continue;
    const headerLine = code.lineAt(b.open);
    const block = code.indentedBlock(headerLine, headerLine);
    batches.push({ table: t, start: block.start, end: block.end });
  }
  const batchTable = (offset: number): string | undefined => batches.find((x) => offset >= x.start && offset <= x.end)?.table;

  const callRe = /\b(op|batch_op)\s*\.\s*(\w+)\s*\(/g;
  callRe.lastIndex = up.start;
  let mt: RegExpExecArray | null;
  while ((mt = callRe.exec(code.masked)) && mt.index < up.end) {
    const receiver = mt[1];
    const fn = mt[2];
    const open = mt.index + mt[0].length - 1;
    const line = code.lineAt(mt.index);
    const args = code.args(open);
    const ctxTable = receiver === 'batch_op' ? batchTable(mt.index) : undefined;
    applyAlembicOp(code, file, fn, args, line, ctxTable, res);
  }
  collectEnums(code, up.start, up.end, res, file);
  return res;
}

function findUpgrade(code: Code): { start: number; end: number } | undefined {
  const m = code.masked;
  const mt = /(^|\n)([ \t]*)def\s+upgrade\s*\(/.exec(m);
  if (!mt) return undefined;
  const defOffset = mt.index + (mt[1] ? 1 : 0);
  const headerLine = code.lineAt(defOffset);
  // header may span lines until ':'
  let p = mt.index + mt[0].length - 1;
  const close = code.closing(p);
  p = close < 0 ? p : close;
  while (p < m.length && m[p] !== ':') p++;
  const block = code.indentedBlock(headerLine, code.lineAt(p));
  return { start: block.start, end: block.end };
}

function alembicTable(args: ReturnType<Code['args']>, ctxTable: string | undefined, index = 0): EntityRef | undefined {
  const name = ctxTable ?? stringValue(positionalText(args, index) ?? '');
  if (!name) return undefined;
  const schema = namedString(args, 'schema');
  return { name, ...(schema ? { schema } : {}) };
}

function applyAlembicOp(
  code: Code,
  file: SourceFile,
  fn: string,
  args: ReturnType<Code['args']>,
  line: number,
  ctxTable: string | undefined,
  res: ParseResult,
): void {
  const src = sourceRef(file, line);
  switch (fn) {
    case 'create_table': {
      const name = stringValue(positionalText(args, 0) ?? '');
      if (!name) return;
      const schema = namedString(args, 'schema');
      const columns: Column[] = [];
      const pk = new Set<string>();
      const indexes: IndexDef[] = [];
      for (let i = 1; i < args.positional.length; i++) {
        const sp = args.positional[i];
        const open = firstParen(code, sp.start, sp.end);
        if (open < 0) continue;
        const head = tail(/^\s*([A-Za-z_][\w.]*)/.exec(sp.text)?.[1] ?? '');
        if (head === 'Column') {
          const parsed = parseColumnCall(code, open);
          if (!parsed.name) continue;
          const col = column(parsed.name, parsed.type, {
            nullable: parsed.nullable ?? !parsed.primaryKey,
            primaryKey: parsed.primaryKey,
            unique: parsed.unique,
            source: sourceRef(file, code.lineAt(sp.start)),
          });
          if (parsed.generated) col.generated = true;
          if (parsed.default !== undefined) col.default = parsed.default;
          if (parsed.comment !== undefined) col.comment = parsed.comment;
          applyEnum(parsed, col, res, file, code.lineAt(sp.start));
          columns.push(col);
          if (parsed.fk) {
            const fkCol = (parsed.fk as { col?: string }).col;
            res.relations.push({
              from: { name },
              fromColumns: [parsed.name],
              to: parsed.fk.ref,
              toColumns: fkCol ? [fkCol] : [],
              cardinality: 'many-to-one',
              kind: 'foreign-key',
              optional: col.nullable,
              ...(parsed.fk.onDelete ? { onDelete: parsed.fk.onDelete } : {}),
              source: src,
            });
          }
        } else if (head === 'PrimaryKeyConstraint') {
          for (const c of quotedList(code.args(open).positional.map((p) => p.text).join(','))) pk.add(c);
        } else if (head === 'ForeignKeyConstraint') {
          const a = code.args(open);
          const localCols = quotedList(positionalText(a, 0) ?? '');
          const refs = quotedList(positionalText(a, 1) ?? '');
          if (localCols.length && refs.length) {
            const t = splitFkTarget(refs[0]);
            res.relations.push({
              from: { name },
              fromColumns: localCols,
              to: { name: t.table, ...(t.schema ? { schema: t.schema } : {}) },
              toColumns: refs.map((r) => splitFkTarget(r).column ?? '').filter(Boolean),
              cardinality: 'many-to-one',
              kind: 'foreign-key',
              optional: true,
              ...fkActions(a),
              source: src,
            });
          }
        } else if (head === 'UniqueConstraint') {
          const a = code.args(open);
          const cols = quotedList(a.positional.map((p) => p.text).join(','));
          if (cols.length) indexes.push({ columns: cols, unique: true, ...(namedString(a, 'name') ? { name: namedString(a, 'name') } : {}) });
        }
      }
      for (const name2 of pk) {
        const col = columns.find((x) => x.name === name2);
        if (col) {
          col.primaryKey = true;
          col.nullable = false;
        }
      }
      const entity: RawEntity = { name, kind: 'table', nameCertainty: 2, columns, source: src };
      if (schema) entity.schema = schema;
      if (indexes.length) entity.indexes = indexes;
      res.entities.push(entity);
      return;
    }
    case 'add_column': {
      const table = alembicTable(args, ctxTable, 0);
      const colArgIndex = ctxTable ? 0 : 1;
      const sp = args.positional[colArgIndex];
      if (!table || !sp) return;
      const open = firstParen(code, sp.start, sp.end);
      if (open < 0) return;
      const parsed = parseColumnCall(code, open);
      if (!parsed.name) return;
      const col = column(parsed.name, parsed.type, {
        nullable: parsed.nullable ?? true,
        primaryKey: parsed.primaryKey,
        unique: parsed.unique,
        source: src,
      });
      if (parsed.default !== undefined) col.default = parsed.default;
      res.entities.push({ name: table.name!, kind: 'table', ...(table.schema ? { schema: table.schema } : {}), partial: true, columns: [col], source: src });
      if (parsed.fk) {
        const fkCol = (parsed.fk as { col?: string }).col;
        res.relations.push({
          from: { name: table.name, ...(table.schema ? { schema: table.schema } : {}) },
          fromColumns: [parsed.name],
          to: parsed.fk.ref,
          toColumns: fkCol ? [fkCol] : [],
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          optional: col.nullable,
          source: src,
        });
      }
      return;
    }
    case 'drop_column': {
      const table = alembicTable(args, ctxTable, 0);
      const colName = stringValue(positionalText(args, ctxTable ? 0 : 1) ?? '');
      if (table && colName) pushOp(res, { op: 'dropColumn', table, column: colName, source: src });
      return;
    }
    case 'alter_column': {
      const table = alembicTable(args, ctxTable, 0);
      const colName = stringValue(positionalText(args, ctxTable ? 0 : 1) ?? '');
      if (!table || !colName) return;
      const rename = namedString(args, 'new_column_name');
      if (rename) pushOp(res, { op: 'renameColumn', table, column: colName, to: rename, source: src });
      const set: ColumnPatch = {};
      const nn = namedBool(args, 'nullable');
      if (nn !== undefined) set.nullable = nn;
      const typeArg = namedText(args, 'type_');
      if (typeArg) set.type = typeName(typeArg);
      const def = namedText(args, 'server_default');
      if (def !== undefined) set.default = def;
      if (Object.keys(set).length) pushOp(res, { op: 'alterColumn', table, column: rename ?? colName, set, source: src });
      return;
    }
    case 'drop_table': {
      const name = stringValue(positionalText(args, 0) ?? '');
      if (name) pushOp(res, { op: 'dropTable', table: { name, ...(namedString(args, 'schema') ? { schema: namedString(args, 'schema') } : {}) }, source: src });
      return;
    }
    case 'rename_table': {
      const from = stringValue(positionalText(args, 0) ?? '');
      const to = stringValue(positionalText(args, 1) ?? '');
      if (from && to) pushOp(res, { op: 'renameTable', table: { name: from }, to, source: src });
      return;
    }
    case 'create_foreign_key': {
      const srcTable = stringValue(positionalText(args, 1) ?? '');
      const refTable = stringValue(positionalText(args, 2) ?? '');
      const localCols = quotedList(positionalText(args, 3) ?? '');
      const refCols = quotedList(positionalText(args, 4) ?? '');
      const cname = stringValue(positionalText(args, 0) ?? '');
      if (srcTable && refTable && localCols.length) {
        res.relations.push({
          from: { name: srcTable },
          fromColumns: localCols,
          to: { name: refTable },
          toColumns: refCols,
          cardinality: 'many-to-one',
          kind: 'foreign-key',
          optional: true,
          ...(cname ? { name: cname } : {}),
          ...fkActions(args),
          source: src,
        });
      }
      return;
    }
    case 'drop_constraint': {
      const cname = stringValue(positionalText(args, 0) ?? '');
      const table = alembicTable(args, ctxTable, 1);
      const type = namedString(args, 'type_');
      if (table && (!type || /foreign/i.test(type))) {
        pushOp(res, { op: 'dropForeignKey', table, ...(cname ? { name: cname } : {}), source: src });
      }
      return;
    }
    case 'create_index': {
      const table = alembicTable(args, ctxTable, ctxTable ? 0 : 1);
      const cols = quotedList(positionalText(args, ctxTable ? 1 : 2) ?? '');
      const iname = stringValue(positionalText(args, 0) ?? '');
      if (table && cols.length) {
        res.entities.push({
          name: table.name!,
          kind: 'table',
          ...(table.schema ? { schema: table.schema } : {}),
          partial: true,
          columns: [],
          indexes: [{ columns: cols, unique: namedBool(args, 'unique') === true, ...(iname ? { name: iname } : {}) }],
          source: src,
        });
      }
      return;
    }
    case 'create_unique_constraint': {
      const table = alembicTable(args, ctxTable, ctxTable ? 0 : 1);
      const cols = quotedList(positionalText(args, ctxTable ? 1 : 2) ?? '');
      const iname = stringValue(positionalText(args, 0) ?? '');
      if (table && cols.length) {
        res.entities.push({
          name: table.name!,
          kind: 'table',
          ...(table.schema ? { schema: table.schema } : {}),
          partial: true,
          columns: [],
          indexes: [{ columns: cols, unique: true, ...(iname ? { name: iname } : {}) }],
          source: src,
        });
      }
      return;
    }
    default:
      return;
  }
}

function pushOp(res: ParseResult, op: SchemaOp): void {
  (res.ops ??= []).push(op);
}

/** `sa.Enum('a','b', name='mood')` / `postgresql.ENUM(..., name='mood')` → RawEnum. */
function collectEnums(code: Code, start: number, end: number, res: ParseResult, file: SourceFile): void {
  for (const call of findCalls(code, start, end, ['Enum', 'ENUM'])) {
    const a = code.args(call.open);
    const name = namedString(a, 'name');
    if (!name) continue;
    const values: string[] = [];
    for (const sp of a.positional) {
      const v = stringValue(sp.text);
      if (v !== undefined) values.push(v);
    }
    if (values.length && !res.enums.some((e) => e.name === name)) {
      res.enums.push({ name, values, source: sourceRef(file, code.lineAt(call.open)) });
    }
  }
}
