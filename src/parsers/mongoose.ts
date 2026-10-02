/**
 * Mongoose parser (`.ts` / `.js` …). Produces document collections and the `mongodb` engine hint.
 *
 * Supports:
 *  - `new Schema({...}, {...})` / `new mongoose.Schema<IUser>({...})` assigned to a variable
 *  - `mongoose.model('User', schema[, 'collection'])` / `model<IUser>(…)` / `connection.model(…)`
 *    (schema and model() may live in different files – names are unified by the resolver)
 *  - refs (single → many-to-one, array → many-to-many), inline string enums, `timestamps`, `_id`
 *  - discriminators (`Base.discriminator('Admin', schema)` → single-table inheritance)
 *  - NestJS `@Schema` / `@Prop` classes and Typegoose `@prop` / `getModelForClass` (best effort)
 *
 * Nested plain objects become a single column of type `Object` (dotted sub-paths are not expanded).
 */

import type { Column, ParseResult, RawEntity, RawRelation, SourceFile } from '../core/model';
import { emptyResult } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { capitalize, defaultTableName } from '../core/naming';
import { boolValue, Code, type Span, stringValue } from '../core/text';
import { JS_EXTENSIONS, type Decorator, decoratorArgs, findClasses, lastSegment, refModel } from './shared/jsmodels';

interface SchemaDef {
  varName?: string;
  fieldsOpen: number;
  optionsOpen?: number;
  newOffset: number;
  line: number;
}

interface ModelCall {
  modelName: string;
  schemaVar?: string;
  schemaStart: number;
  schemaEnd: number;
  collection?: string;
  modelVar?: string;
  line: number;
}

interface Analyzed {
  type: string;
  isArray: boolean;
  ref?: string;
  enumValues?: string[];
  required: boolean;
  unique: boolean;
  default?: string;
  nested: boolean;
}

export const mongooseParser: SchemaParser = {
  kind: 'mongoose',
  extensions: [...JS_EXTENSIONS],
  detect(file: SourceFile): boolean {
    const t = file.text;
    if (/from\s+['"]@nestjs\/mongoose['"]/.test(t) || /from\s+['"]@typegoose\/typegoose['"]/.test(t)) return true;
    const hasMongoose =
      /from\s+['"]mongoose['"]/.test(t) || /require\(\s*['"]mongoose['"]\s*\)/.test(t) || /\bmongoose\s*\./.test(t);
    if (!hasMongoose) return false;
    return /new\s+(?:mongoose\s*\.\s*)?Schema\b/.test(t) || /\bmongoose\s*\.\s*Schema\s*\(/.test(t) || /\.model\s*</.test(t) || /\.model\s*\(/.test(t) || /\bSchema\s*\.\s*Types\b/.test(t);
  },
  parse,
};

function parse(file: SourceFile): ParseResult {
  const result = emptyResult('definition');
  if (!file.text) return result;
  const code = new Code(file.text, 'js');

  const schemas = findSchemas(code);
  const modelCalls = findModelCalls(code);
  const discriminators = findDiscriminators(code);

  // model variable name → model name (for discriminator base resolution)
  const modelVarToName = new Map<string, string>();
  for (const mc of modelCalls) if (mc.modelVar) modelVarToName.set(mc.modelVar, mc.modelName);

  // schema variable → discriminator { discName, base }
  const discBySchemaVar = new Map<string, { discName: string; base: string }>();
  for (const d of discriminators) {
    if (!d.schemaVar) continue;
    discBySchemaVar.set(d.schemaVar, { discName: d.discName, base: modelVarToName.get(d.receiver) ?? d.receiver });
  }

  let emittedMongodb = false;
  const emitEngine = (line: number) => {
    if (!emittedMongodb) {
      (result.engines ??= []).push({ engine: 'mongodb', line, detail: 'Mongoose schema' });
      emittedMongodb = true;
    }
  };

  const usedSchemaVars = new Set<string>();

  for (const sd of schemas) {
    // find the model() call that uses this schema (by variable or inline position)
    const mc = modelCalls.find(
      (m) => (sd.varName && m.schemaVar === sd.varName) || (sd.newOffset >= m.schemaStart && sd.newOffset < m.schemaEnd),
    );
    if (mc?.schemaVar) usedSchemaVars.add(mc.schemaVar);

    const disc = sd.varName ? discBySchemaVar.get(sd.varName) : undefined;
    let modelName = mc?.modelName ?? disc?.discName ?? deriveModelName(sd.varName);
    const options = sd.optionsOpen !== undefined ? parseOptions(code, sd.optionsOpen) : {};
    const collection = mc?.collection ?? options.collection;
    const name = collection ?? defaultTableName('mongoose', modelName);
    const certainty = collection ? 2 : 0;

    emitEngine(sd.line);
    emitSchemaEntity(result, file, code, {
      modelName,
      name,
      certainty,
      fieldsOpen: sd.fieldsOpen,
      options,
      line: sd.line,
      disc,
    });
  }

  // model() calls whose schema is defined elsewhere → partial entity so names unify across files
  for (const mc of modelCalls) {
    if (mc.schemaVar && usedSchemaVars.has(mc.schemaVar)) continue;
    const definedHere = schemas.some(
      (sd) => (sd.varName && sd.varName === mc.schemaVar) || (sd.newOffset >= mc.schemaStart && sd.newOffset < mc.schemaEnd),
    );
    if (definedHere) continue;
    emitEngine(mc.line);
    const entity: RawEntity = {
      name: mc.collection ?? defaultTableName('mongoose', mc.modelName),
      kind: 'collection',
      modelName: mc.modelName,
      nameCertainty: mc.collection ? 2 : 0,
      columns: [],
      partial: true,
      engine: 'mongodb',
      source: sourceRef(file, mc.line),
    };
    result.entities.push(entity);
  }

  parseDecoratedClasses(result, file, code, emitEngine);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────────────────────

function findSchemas(code: Code): SchemaDef[] {
  const m = code.masked;
  const out: SchemaDef[] = [];
  const re = /(?:\bnew\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?<!@)\bSchema\s*(?:<[^>]*>\s*)?\(/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const open = mt.index + mt[0].length - 1;
    const args = code.args(open);
    const fields = args.positional[0];
    if (!fields || fields.text[0] !== '{') {
      re.lastIndex = open + 1;
      continue;
    }
    const options = args.positional[1];
    out.push({
      varName: assignedVar(code, mt.index),
      fieldsOpen: fields.start,
      optionsOpen: options && options.text[0] === '{' ? options.start : undefined,
      newOffset: mt.index,
      line: code.lineAt(mt.index),
    });
    re.lastIndex = args.end;
  }
  return out;
}

function findModelCalls(code: Code): ModelCall[] {
  const m = code.masked;
  const out: ModelCall[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*\.\s*model\s*(?:<[^>]*>\s*)?\(/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const open = mt.index + mt[0].length - 1;
    const args = code.args(open);
    const nameSpan = args.positional[0];
    const schemaSpan = args.positional[1];
    const collSpan = args.positional[2];
    const modelName = nameSpan ? stringValue(nameSpan.text) : undefined;
    re.lastIndex = args.end;
    if (!modelName || !schemaSpan) continue; // model('User') retrieval, not a definition
    out.push({
      modelName,
      schemaVar: /^[A-Za-z_$][\w$]*$/.test(schemaSpan.text) ? schemaSpan.text : undefined,
      schemaStart: schemaSpan.start,
      schemaEnd: schemaSpan.end,
      collection: collSpan ? stringValue(collSpan.text) : undefined,
      modelVar: assignedVar(code, mt.index),
      line: code.lineAt(mt.index),
    });
  }
  return out;
}

interface Disc {
  receiver: string;
  discName: string;
  schemaVar?: string;
}

function findDiscriminators(code: Code): Disc[] {
  const m = code.masked;
  const out: Disc[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*\.\s*discriminator\s*(?:<[^>]*>\s*)?\(/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const open = mt.index + mt[0].length - 1;
    const args = code.args(open);
    const nameSpan = args.positional[0];
    const schemaSpan = args.positional[1];
    const discName = nameSpan ? stringValue(nameSpan.text) : undefined;
    re.lastIndex = args.end;
    if (!discName) continue;
    out.push({
      receiver: mt[1],
      discName,
      schemaVar: schemaSpan && /^[A-Za-z_$][\w$]*$/.test(schemaSpan.text) ? schemaSpan.text : undefined,
    });
  }
  return out;
}

/** Variable a `new …` / call expression at `offset` is assigned to. */
function assignedVar(code: Code, offset: number): string | undefined {
  const s = code.stripped.slice(Math.max(0, offset - 240), offset);
  const m = /(?:^|[;{}\n)])\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*$/.exec(s);
  return m ? m[1] : undefined;
}

function deriveModelName(varName: string | undefined): string {
  if (!varName) return 'Model';
  const stripped = varName.replace(/[_-]?[Ss]chema$/, '').replace(/[_-]?[Mm]odel$/, '');
  return capitalize(stripped || varName);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entity emission from a schema object
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SchemaOptions {
  collection?: string;
  noId?: boolean;
  timestamps?: { createdAt: string; updatedAt: string };
}

function parseOptions(code: Code, open: number): SchemaOptions {
  const obj = code.object(open);
  const out: SchemaOptions = {};
  const coll = obj.get('collection');
  if (coll) out.collection = stringValue(coll.text);
  const id = obj.get('_id');
  if (id && boolValue(id.text) === false) out.noId = true;
  const ts = obj.get('timestamps');
  if (ts) out.timestamps = parseTimestamps(code, ts);
  return out;
}

function parseTimestamps(code: Code, span: Span): { createdAt: string; updatedAt: string } | undefined {
  const t = span.text.trim();
  if (boolValue(t) === true) return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
  if (t[0] === '{') {
    const obj = code.object(span.start);
    const ca = obj.get('createdAt');
    const ua = obj.get('updatedAt');
    const caName = ca ? (stringValue(ca.text) ?? (boolValue(ca.text) === false ? '' : 'createdAt')) : 'createdAt';
    const uaName = ua ? (stringValue(ua.text) ?? (boolValue(ua.text) === false ? '' : 'updatedAt')) : 'updatedAt';
    return { createdAt: caName, updatedAt: uaName };
  }
  return undefined;
}

interface EmitArgs {
  modelName: string;
  name: string;
  certainty: 0 | 2;
  fieldsOpen: number;
  options: SchemaOptions;
  line: number;
  disc?: { discName: string; base: string };
}

function emitSchemaEntity(result: ParseResult, file: SourceFile, code: Code, a: EmitArgs): void {
  const columns: Column[] = [];
  const fields = code.object(a.fieldsOpen);
  for (const [fieldName, span] of fields) {
    if (fieldName === '__v') continue;
    const info = analyzeValue(code, span);
    const col = buildColumn(file, fieldName, info, code.lineAt(span.start));
    if (info.enumValues?.length) col.enumRef = `${a.name}_${fieldName}`;
    columns.push(col);
    addFieldExtras(result, file, code, a, fieldName, info, span);
  }
  finishEntity(result, file, columns, a);
}

function finishEntity(result: ParseResult, file: SourceFile, columns: Column[], a: EmitArgs): void {
  prependImplicit(columns, a, file);
  const entity: RawEntity = {
    name: a.name,
    kind: 'collection',
    modelName: a.modelName,
    nameCertainty: a.certainty,
    columns,
    engine: 'mongodb',
    source: sourceRef(file, a.line),
  };
  if (a.disc) {
    entity.sharedTable = true;
    entity.extends = [a.disc.base];
  }
  result.entities.push(entity);
}

function prependImplicit(columns: Column[], a: EmitArgs, file: SourceFile): void {
  if (!a.options.noId && !columns.some((c) => c.name === '_id') && !a.disc) {
    columns.unshift(column('_id', 'ObjectId', { primaryKey: true, nullable: false, source: sourceRef(file, a.line) }));
  }
  const ts = a.options.timestamps;
  if (ts) {
    for (const n of [ts.createdAt, ts.updatedAt]) {
      if (n && !columns.some((c) => c.name === n)) columns.push(column(n, 'Date', { nullable: false, source: sourceRef(file, a.line) }));
    }
  }
}

function addFieldExtras(
  result: ParseResult,
  file: SourceFile,
  _code: Code,
  a: EmitArgs,
  fieldName: string,
  info: Analyzed,
  span: Span,
): void {
  const line = _code.lineAt(span.start);
  if (info.enumValues?.length) {
    result.enums.push({ name: `${a.name}_${fieldName}`, values: info.enumValues, source: sourceRef(file, line) });
  }
  if (info.ref) {
    const rel: RawRelation = {
      from: { model: a.modelName, name: a.name },
      fromColumns: info.isArray ? [] : [fieldName],
      to: { model: info.ref },
      toColumns: [],
      cardinality: info.isArray ? 'many-to-many' : 'many-to-one',
      kind: 'orm',
      source: sourceRef(file, line),
    };
    if (!info.isArray && !info.required) rel.optional = true;
    result.relations.push(rel);
  }
}

function buildColumn(file: SourceFile, name: string, info: Analyzed, line: number): Column {
  const props: Partial<Column> = { nullable: !info.required, unique: info.unique, source: sourceRef(file, line) };
  if (info.isArray) props.isArray = true;
  if (info.default !== undefined) props.default = info.default;
  return column(name, info.ref ? 'ObjectId' : info.type, props);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Value analysis
// ─────────────────────────────────────────────────────────────────────────────────────────────

function analyzeValue(code: Code, span: Span): Analyzed {
  const base: Analyzed = { type: '', isArray: false, required: false, unique: false, nested: false };
  const t = span.text.trim();
  if (!t) return base;

  if (t[0] === '[') {
    const items = code.items(span.start);
    if (!items.length) return { ...base, isArray: true };
    const inner = analyzeValue(code, items[0]);
    return { ...inner, isArray: true };
  }

  if (t[0] === '{') {
    const obj = code.object(span.start);
    if (!obj.has('type') && !obj.has('ref')) {
      return { ...base, type: 'Object', nested: true }; // nested sub-document
    }
    return analyzeOptionsObject(code, span.start);
  }

  return { ...base, type: normalizeType(t) };
}

/** Parses a `{ type, ref, required, unique, default, enum }` options object. */
function analyzeOptionsObject(code: Code, open: number): Analyzed {
  const obj = code.object(open);
  const typeSpan = obj.get('type');
  const typeInfo: Analyzed = typeSpan
    ? analyzeValue(code, typeSpan)
    : { type: '', isArray: false, required: false, unique: false, nested: false };
  const ref = refOf(obj.get('ref'));
  const req = obj.get('required');
  const uni = obj.get('unique');
  const def = obj.get('default');
  const en = obj.get('enum');
  return {
    type: typeInfo.type || (ref ? 'ObjectId' : ''),
    isArray: typeInfo.isArray,
    ref: ref ?? typeInfo.ref,
    enumValues: en ? enumValues(code, en) : undefined,
    required: !!req && (boolValue(req.text) === true || req.text.trim()[0] === '['),
    unique: boolValue(uni?.text) === true,
    default: def ? (stringValue(def.text) ?? def.text.trim()) : undefined,
    nested: false,
  };
}

function refOf(span: Span | undefined): string | undefined {
  if (!span) return undefined;
  return refModel(span.text);
}

function enumValues(code: Code, span: Span): string[] | undefined {
  const t = span.text.trim();
  let items: Span[];
  if (t[0] === '[') items = code.items(span.start);
  else if (t[0] === '{') {
    const values = code.object(span.start).get('values');
    items = values && values.text[0] === '[' ? code.items(values.start) : [];
  } else return undefined;
  const out: string[] = [];
  for (const it of items) {
    const v = stringValue(it.text);
    if (v === undefined) return undefined; // not a plain string enum (e.g. a TS enum reference)
    out.push(v);
  }
  return out.length ? out : undefined;
}

const TS_TO_MONGOOSE: Readonly<Record<string, string>> = {
  string: 'String',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  buffer: 'Buffer',
};

function normalizeType(expr: string): string {
  const seg = lastSegment(expr);
  return TS_TO_MONGOOSE[seg.toLowerCase()] ?? seg;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// NestJS @Schema / @Prop and Typegoose @prop classes
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseDecoratedClasses(result: ParseResult, file: SourceFile, code: Code, emitEngine: (line: number) => void): void {
  const factoryClasses = new Set<string>();
  for (const m of code.masked.matchAll(/(?:SchemaFactory\s*\.\s*createForClass|getModelForClass)\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    factoryClasses.add(m[1]);
  }

  for (const cls of findClasses(code)) {
    const schemaDec = cls.decorators.find((d) => d.name === 'Schema');
    const hasProps = cls.members.some((mem) => mem.decorators.some((d) => d.name === 'Prop' || d.name === 'prop'));
    if (!schemaDec && !hasProps && !factoryClasses.has(cls.name)) continue;

    const options = schemaDec ? parseDecoratorOptions(code, schemaDec) : {};
    const collection = options.collection;
    const name = collection ?? defaultTableName('mongoose', cls.name);
    const a: EmitArgs = {
      modelName: cls.name,
      name,
      certainty: collection ? 2 : 0,
      fieldsOpen: cls.bodyOpen,
      options,
      line: cls.line,
    };
    if (cls.extendsName) {
      a.disc = { discName: cls.name, base: cls.extendsName };
    }

    emitEngine(cls.line);
    const columns: Column[] = [];
    for (const mem of cls.members) {
      if (mem.kind !== 'prop') continue;
      const prop = mem.decorators.find((d) => d.name === 'Prop' || d.name === 'prop');
      if (!prop) continue;
      const info = analyzePropMember(code, mem, prop.open >= 0 ? prop.open : -1);
      const col = buildColumn(file, mem.name, info, mem.line);
      if (info.enumValues?.length) col.enumRef = `${a.name}_${mem.name}`;
      columns.push(col);
      addFieldExtras(result, file, code, a, mem.name, info, { start: mem.start, end: mem.start, text: '' });
    }
    finishEntity(result, file, columns, a);
  }
}

function parseDecoratorOptions(code: Code, dec: Decorator): SchemaOptions {
  if (dec.open < 0) return {};
  const args = decoratorArgs(code, dec);
  const first = args?.positional[0];
  return first && first.text[0] === '{' ? parseOptions(code, first.start) : {};
}

function analyzePropMember(code: Code, mem: { type: string; optional: boolean }, propOpen: number): Analyzed {
  if (propOpen >= 0) {
    const first = code.args(propOpen).positional[0];
    if (first) {
      const t = first.text.trim();
      if (t[0] === '{') {
        const info = analyzeOptionsObject(code, first.start);
        if (!info.type && !info.ref) {
          const ts = fromTsType(mem.type);
          info.type = ts.type;
          info.isArray = info.isArray || ts.isArray;
        }
        return info;
      }
      if (t[0] === '[') return analyzeValue(code, first);
      return { type: normalizeType(t), isArray: false, required: false, unique: false, nested: false };
    }
  }
  // fall back to the TypeScript type annotation (mongoose fields are optional by default)
  return fromTsType(mem.type);
}

function fromTsType(tsType: string): Analyzed {
  const base: Analyzed = { type: '', isArray: false, required: false, unique: false, nested: false };
  let t = tsType.trim();
  if (!t) return base;
  let isArray = false;
  const arr = /^(?:Array\s*<\s*(.+?)\s*>|(.+?)\s*\[\s*\])$/.exec(t);
  if (arr) {
    isArray = true;
    t = (arr[1] ?? arr[2]).trim();
  }
  t = t.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
  const seg = lastSegment(t);
  if (/ObjectId/i.test(t)) return { ...base, type: 'ObjectId', isArray };
  return { ...base, type: TS_TO_MONGOOSE[seg.toLowerCase()] ?? seg, isArray };
}
