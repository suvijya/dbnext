/**
 * ZenStack `schema.zmodel` parser. ZModel is a superset of the Prisma schema language, so the text is
 * normalised (`model A extends B, C {` → `model A  {`, access-policy attributes are ignored by the
 * Prisma reader) and handed to the Prisma parser. `abstract model` blocks become abstract entities
 * whose columns are inherited through `extends`.
 */

import type { ParseResult, SourceFile } from '../core/model';
import type { SchemaParser } from '../core/parser';
import { prismaParser } from './prisma';

const EXTENDS = /\b(model|view)\s+([A-Za-z_]\w*)\s+extends\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)(?=\s*\{)/g;

function detect(file: SourceFile): boolean {
  return /(^|\n)\s*(abstract\s+)?(model|enum|datasource|generator|plugin)\s+[A-Za-z_]/.test(file.text);
}

function parse(file: SourceFile): ParseResult {
  const bases = new Map<string, string[]>();
  // Blank the `extends …` clause but keep every offset and newline, so line numbers stay exact.
  const text = file.text.replace(EXTENDS, (whole: string, kw: string, name: string, list: string) => {
    bases.set(name, list.split(',').map((s) => s.trim()));
    const head = `${kw} ${name}`;
    return head + whole.slice(head.length).replace(/[^\r\n]/g, ' ');
  });
  const abstractNames = new Set<string>();
  for (const m of text.matchAll(/\babstract\s+model\s+([A-Za-z_]\w*)/g)) abstractNames.add(m[1]);

  const result = prismaParser.parse({ ...file, text });
  for (const e of result.entities) {
    if (!e.modelName) continue;
    if (abstractNames.has(e.modelName)) e.abstract = true;
    const ext = bases.get(e.modelName);
    if (ext) e.extends = ext;
  }
  return result;
}

export const zmodelParser: SchemaParser = {
  kind: 'zenstack',
  extensions: ['.zmodel'],
  detect,
  parse,
};
