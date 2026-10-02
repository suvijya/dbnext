import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { seaormParser } from '../../../src/parsers/seaorm';

const parse = (path: string, text: string) => seaormParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'seaorm', result: parse(path, text) });

const cakeRs = `
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "cake", schema_name = "bakery")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(column_type = "Text", nullable, unique, column_name = "cake_name")]
    pub name: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::fruit::Entity")]
    Fruit,
}

#[derive(EnumIter, DeriveActiveEnum)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "tea")]
pub enum Tea {
    #[sea_orm(string_value = "EverydayTea")]
    EverydayTea,
    #[sea_orm(string_value = "BreakfastTea")]
    BreakfastTea,
}

impl ActiveModelBehavior for ActiveModel {}
`;

const fruitRs = `
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "fruit")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i32,
    pub name: String,
    pub cake_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::cake::Entity",
        from = "Column::CakeId",
        to = "super::cake::Column::Id",
        on_delete = "Cascade"
    )]
    Cake,
}

impl ActiveModelBehavior for ActiveModel {}
`;

describe('seaorm detect', () => {
  it('claims sea_orm entity / relation / enum files', () => {
    expect(seaormParser.detect({ path: 'cake.rs', text: cakeRs })).toBe(true);
    expect(seaormParser.detect({ path: 'fruit.rs', text: fruitRs })).toBe(true);
  });

  it('ignores Diesel (table! macros) and unrelated Rust', () => {
    const diesel = 'diesel::table! {\n  users (id) {\n    id -> Int4,\n    name -> Text,\n  }\n}';
    expect(seaormParser.detect({ path: 'schema.rs', text: diesel })).toBe(false);
    expect(seaormParser.detect({ path: 'main.rs', text: 'fn main() { println!("hi"); }' })).toBe(false);
  });
});

describe('seaorm parse', () => {
  const cake = parse('src/entity/cake.rs', cakeRs);
  const model = cake.entities[0];

  it('uses the module name as the model name and the explicit table/schema', () => {
    expect(model).toMatchObject({ name: 'cake', modelName: 'cake', schema: 'bakery', nameCertainty: 2 });
  });

  it('maps columns with Option → nullable, column_name / column_type overrides, auto-increment PK', () => {
    expect(model.columns.map((c) => c.name)).toEqual(['id', 'cake_name']);
    expect(model.columns.find((c) => c.name === 'id')).toMatchObject({ type: 'i32', primaryKey: true, nullable: false, generated: true });
    expect(model.columns.find((c) => c.name === 'cake_name')).toMatchObject({ type: 'Text', nullable: true, unique: true });
  });

  it('reads has_many relations targeting the referenced module', () => {
    expect(cake.relations).toEqual([expect.objectContaining({ from: { model: 'cake' }, to: { model: 'fruit' }, cardinality: 'one-to-many' })]);
  });

  it('reads DeriveActiveEnum enums', () => {
    expect(cake.enums).toEqual([expect.objectContaining({ name: 'tea', values: ['EverydayTea', 'BreakfastTea'] })]);
  });

  it('does not auto-increment a non-integer-style PK (auto_increment = false)', () => {
    const fruit = parse('src/entity/fruit.rs', fruitRs);
    expect(fruit.entities[0].columns.find((c) => c.name === 'id')!.generated).toBeUndefined();
    expect(fruit.entities[0].columns.find((c) => c.name === 'cake_id')).toMatchObject({ type: 'i32', nullable: true });
  });

  it('reads belongs_to with column mapping and on_delete', () => {
    const fruit = parse('src/entity/fruit.rs', fruitRs);
    expect(fruit.relations).toEqual([
      expect.objectContaining({ from: { model: 'fruit' }, fromColumns: ['cake_id'], to: { model: 'cake' }, toColumns: ['id'], cardinality: 'many-to-one', onDelete: 'CASCADE' }),
    ]);
  });

  it('skips mod.rs / lib.rs / prelude.rs and does not throw on malformed input', () => {
    expect(parse('src/entity/mod.rs', 'pub mod cake;\npub mod fruit;').entities).toHaveLength(0);
    expect(() => parse('x.rs', '#[derive(DeriveEntityModel)]\n#[sea_orm(table_name = "x"\npub struct Model {')).not.toThrow();
  });
});

describe('seaorm end-to-end', () => {
  it('resolves the two entities and a single de-duplicated fruit → cake relation', () => {
    const r = resolveSchema([fr('src/entity/cake.rs', cakeRs), fr('src/entity/fruit.rs', fruitRs)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['bakery.cake', 'fruit']);

    const fruit = r.entities.find((e) => e.id === 'fruit')!;
    expect(fruit.columns.map((c) => c.name)).toEqual(['id', 'name', 'cake_id']);
    expect(fruit.columns.find((c) => c.name === 'cake_id')!.references).toEqual({ entity: 'bakery.cake', column: 'id' });

    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ from: 'fruit', to: 'bakery.cake', fromColumns: ['cake_id'], cardinality: 'many-to-one', onDelete: 'CASCADE', optional: true });

    expect(r.enums.map((e) => e.name)).toEqual(['tea']);
  });
});
