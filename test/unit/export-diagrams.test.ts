import { describe, expect, it } from 'vitest';
import { registry } from '../../src/parsers';
import { buildModel } from '../../src/core/resolve';
import { parseFile } from '../../src/core/scan';
import { toDbml, toPlantUml } from '../../src/core/exportDiagrams';
import { parseViews, sanitizeViews, serializeViews } from '../../src/core/views';
import type { SchemaModel } from '../../src/core/model';

const SQL = `
CREATE TABLE users (id integer PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, name text DEFAULT 'anon');
CREATE TABLE billing.invoices (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total numeric(10,2) NOT NULL
);
CREATE TABLE "order items" (id integer PRIMARY KEY, invoice_id integer REFERENCES billing.invoices(id));
CREATE INDEX idx_inv_user ON billing.invoices (user_id, total);
`;

function modelOf(files: Record<string, string>): SchemaModel {
  const results = [];
  for (const [path, text] of Object.entries(files)) results.push(...parseFile({ path, text }, registry).results);
  return buildModel({
    workspaceName: 't', results, engineHints: [], warnings: [], inferRelations: false, now: new Date(0),
    stats: { filesFound: 1, filesRead: 1, filesParsed: 1, durationMs: 0, truncated: false },
  });
}

describe('DBML exporter', () => {
  const model = modelOf({ 'schema.sql': SQL });
  const dbml = toDbml(model);

  it('round-trips through the DBML parser', () => {
    const back = modelOf({ 'out.dbml': dbml });
    const shape = (m: SchemaModel) => ({
      tables: m.entities.map((e) => `${e.schema ?? ''}.${e.name}`).sort(),
      columns: m.entities.flatMap((e) => e.columns.map((c) => `${e.name}.${c.name}:${c.primaryKey}:${c.nullable}:${c.unique}`)).sort(),
      relations: m.relations.map((r) => `${r.from}.${r.fromColumns}>${r.to}.${r.toColumns}:${r.cardinality}`).sort(),
    });
    expect(model.entities.length).toBe(3);
    expect(model.relations.length).toBe(2);
    expect(shape(back)).toEqual(shape(model));
  });

  it('restricts to a subset and drops dangling refs', () => {
    const users = model.entities.find((e) => e.name === 'users')!;
    const out = toDbml(model, { entityIds: [users.id] });
    expect(out).toContain('Table users');
    expect(out).not.toContain('invoices');
    expect(out).not.toContain('Ref:');
  });
});

describe('PlantUML exporter', () => {
  const model = modelOf({ 'schema.sql': SQL });
  it('emits entities and crow\'s-foot relations', () => {
    const out = toPlantUml(model);
    expect(out.startsWith('@startuml\n')).toBe(true);
    expect(out.trimEnd().endsWith('@enduml')).toBe(true);
    expect(out).toContain('entity "billing.invoices" as');
    expect(out).toContain('<<PK>>');
    expect(out).toMatch(/e\d }o--\|\| e\d : user_id/);
    expect(out.match(/entity /g)?.length).toBe(3);
  });
  it('honours the entity subset', () => {
    const users = model.entities.find((e) => e.name === 'users')!;
    const out = toPlantUml(model, { entityIds: [users.id] });
    expect(out.match(/entity /g)?.length).toBe(1);
    expect(out).not.toContain('}o--');
  });
});

describe('saved views', () => {
  it('sanitizes, dedupes and round-trips', () => {
    const views = sanitizeViews([
      { name: ' Billing ', entities: ['a', 'a', 'b', 3] },
      { name: 'billing', entities: ['x'] },
      { name: '', entities: [] },
      { name: 'bad' },
    ]);
    expect(views).toEqual([{ name: 'Billing', entities: ['a', 'b'] }]);
    expect(parseViews(serializeViews(views))).toEqual(views);
  });
  it('bad JSON yields no views', () => {
    expect(parseViews('{nope')).toEqual([]);
    expect(parseViews('null')).toEqual([]);
  });
});
