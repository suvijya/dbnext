/**
 * MongoDB `$jsonSchema` validator parser. Reads `createCollection("name", { validator: { $jsonSchema:
 * { … } } })` calls (mongosh scripts, migration files, Node driver code in `.js` / `.ts`) and turns them
 * into document collections.
 *
 * `bsonType` / `type` (string or array; `"null"` makes the field nullable), `required`, `enum`,
 * `description`, array `items` and nested `properties` (flattened to dotted names, depth <= 4) are read.
 * `detect` requires both `createCollection(` and `$jsonSchema`, so Mongoose and other files are not claimed.
 */

import type { Column, ParseResult, RawEntity, SourceFile } from '../core/model';
import { column, sourceRef, type SchemaParser } from '../core/parser';
import { Code, stringValue, type Span } from '../core/text';

const MAX_DEPTH = 4;

function detect(file: SourceFile): boolean {
  return file.text.includes('createCollection') && file.text.includes('$jsonSchema');
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const code = new Code(file.text, 'js');
  const re = /\bcreateCollection\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code.masked))) {
    const open = m.index + m[0].length - 1;
    const args = code.args(open);
    const name = stringValue(args.positional[0]?.text);
    const optsSpan = args.positional[1];
    if (!name || !optsSpan || !optsSpan.text.startsWith('{')) continue;
    const validator = code.object(optsSpan.start).get('validator');
    if (!validator || !validator.text.startsWith('{')) continue;
    const schemaSpan = code.object(validator.start).get('$jsonSchema');
    if (!schemaSpan || !schemaSpan.text.startsWith('{')) continue;

    const line = code.lineAt(m.index);
    const entity: RawEntity = { name, kind: 'collection', nameCertainty: 2, columns: [], engine: 'mongodb', source: sourceRef(file, line) };
    const schema = code.object(schemaSpan.start);
    const desc = stringValue(schema.get('description')?.text);
    if (desc) entity.comment = desc;
    collect(code, file, schemaSpan, '', 0, entity.columns);
    if (!entity.columns.some((c) => c.name === '_id')) {
      entity.columns.unshift(column('_id', 'objectId', { nullable: false, primaryKey: true, generated: true, source: sourceRef(file, line) }));
    }
    (result.engines ??= []).push({ engine: 'mongodb', line, detail: 'createCollection with $jsonSchema validator' });
    result.entities.push(entity);
    re.lastIndex = optsSpan.end;
  }
  return result;
}

/** Quoted strings of a literal that is either `"x"` or `["x", "y"]`. */
function strings(span: Span | undefined): string[] {
  if (!span) return [];
  const single = stringValue(span.text);
  if (single !== undefined) return [single];
  return [...span.text.matchAll(/(["'])((?:(?!\1).)*)\1/g)].map((x) => x[2]);
}

function collect(code: Code, file: SourceFile, schemaSpan: Span, prefix: string, depth: number, out: Column[]): void {
  const schema = code.object(schemaSpan.start);
  const props = schema.get('properties');
  if (!props || !props.text.startsWith('{')) return;
  const required = new Set(strings(schema.get('required')));
  for (const [key, span] of code.object(props.start)) {
    if (!span.text.startsWith('{')) continue;
    const def = code.object(span.start);
    const types = strings(def.get('bsonType') ?? def.get('type'));
    const nullable = !required.has(key) || types.includes('null');
    const real = types.filter((t) => t !== 'null');
    let type = real.join('|');
    const items = def.get('items');
    let isArray = false;
    if (real.includes('array')) {
      isArray = true;
      const it = items && items.text.startsWith('{') ? strings(code.object(items.start).get('bsonType') ?? code.object(items.start).get('type')) : [];
      type = it.length ? it.join('|') : 'array';
    }
    const name = prefix ? `${prefix}.${key}` : key;
    const col = column(name, type, { nullable: key === '_id' ? false : nullable, primaryKey: key === '_id', source: sourceRef(file, code.lineAt(span.start)) });
    if (isArray) col.isArray = true;
    const en = strings(def.get('enum'));
    if (en.length && !type) col.type = 'enum';
    const desc = stringValue(def.get('description')?.text);
    if (desc) col.comment = desc;
    out.push(col);
    if (depth < MAX_DEPTH && def.has('properties')) collect(code, file, span, name, depth + 1, out);
    else if (depth < MAX_DEPTH && isArray && items && items.text.startsWith('{') && code.object(items.start).has('properties')) {
      collect(code, file, items, name, depth + 1, out);
    }
  }
}

export const mongovalidatorParser: SchemaParser = {
  kind: 'mongovalidator',
  extensions: ['.js', '.mjs', '.cjs', '.ts'],
  detect,
  parse,
};
