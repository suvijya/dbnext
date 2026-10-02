import { describe, expect, it } from 'vitest';
import { seaormParser } from '../../../src/parsers/seaorm';

const parse = (path: string, text: string) => seaormParser.parse({ path, text });

// Found in SeaQL/sea-orm (sea-orm-codegen tests/*/rust_keyword.rs).
describe('seaorm edge cases', () => {
  it('reads raw-identifier fields (r#type) as columns', () => {
    const text = [
      'use sea_orm::entity::prelude::*;',
      '#[derive(Clone, Debug, DeriveEntityModel)]',
      '#[sea_orm(table_name = "rust_keyword")]',
      'pub struct Model {',
      '    #[sea_orm(primary_key)]',
      '    pub id: i32,',
      '    pub r#type: u16,',
      '    pub r#match: Option<String>,',
      '    pub normal: String,',
      '}',
    ].join('\n');
    const model = parse('entity/rust_keyword.rs', text).entities.find((e) => e.name === 'rust_keyword')!;
    const cols = model.columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'type', 'match', 'normal']));
    expect(model.columns.find((c) => c.name === 'match')!.nullable).toBe(true); // Option<String>
  });

  it('CRLF line endings produce identical results', () => {
    const text = [
      'use sea_orm::entity::prelude::*;',
      '#[derive(Clone, Debug, DeriveEntityModel)]',
      '#[sea_orm(table_name = "cake")]',
      'pub struct Model {',
      '    #[sea_orm(primary_key)]',
      '    pub id: i32,',
      '    pub name: String,',
      '    pub r#type: Option<String>,',
      '}',
    ].join('\n');
    const lf = parse('entity/cake.rs', text);
    const crlf = parse('entity/cake.rs', text.replace(/\n/g, '\r\n'));
    expect(JSON.stringify(crlf)).toEqual(JSON.stringify(lf));
  });
});
