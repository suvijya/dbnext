import { describe, expect, it } from 'vitest';
import { liquibaseParser } from '../../../src/parsers/liquibase';

// Edge-case coverage for the Liquibase changelog parser across XML / YAML / JSON.
const parse = (path: string, text: string) => liquibaseParser.parse({ path, text });

const YAML = [
  'databaseChangeLog:',
  '  - changeSet:',
  '      id: 1',
  '      author: a',
  '      changes:',
  '        - createTable:',
  '            tableName: account',
  '            columns:',
  '              - column:',
  '                  name: id',
  '                  type: bigint',
  '                  autoIncrement: true',
  '                  constraints:',
  '                    primaryKey: true',
  '                    nullable: false',
  '              - column:',
  '                  name: owner_id',
  '                  type: bigint',
  '                  constraints:',
  '                    referencedTableName: users',
  '                    referencedColumnNames: id',
  '                    foreignKeyName: fk_ao',
  '      rollback:',
  '        - dropTable:',
  '            tableName: account',
  '  - changeSet:',
  '      id: 2',
  '      author: a',
  '      changes:',
  '        - dropColumn:',
  '            tableName: account',
  '            columnName: owner_id',
].join('\n');

describe('liquibase YAML', () => {
  it('reads createTable columns, resolves the FK and ignores the rollback block', () => {
    const r = parse('db/changelog.yaml', YAML);
    const account = r.entities.find((e) => e.name === 'account' && !e.partial);
    expect(account?.columns.map((c) => c.name)).toEqual(['id', 'owner_id']);
    expect(account?.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, nullable: false, generated: true });
    expect(r.relations.map((x) => `${x.from.name}->${x.to.name}`)).toEqual(['account->users']);
    // The rollback's dropTable must NOT turn into a dropTable op.
    expect(r.ops?.map((o) => o.op)).toEqual(['dropColumn']);
  });

  it('CRLF line endings produce the identical result to LF', () => {
    expect(JSON.stringify(parse('db/changelog.yaml', YAML))).toBe(JSON.stringify(parse('db/changelog.yaml', YAML.replace(/\n/g, '\r\n'))));
  });
});

describe('liquibase XML', () => {
  it('reads namespaced tags, column constraints and references into a FK', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">',
      '  <changeSet id="1" author="me">',
      '    <createTable tableName="orders">',
      '      <column name="id" type="BIGINT"><constraints primaryKey="true" nullable="false"/></column>',
      '      <column name="customer_id" type="BIGINT">',
      '        <constraints referencedTableName="customers" referencedColumnNames="id" foreignKeyName="fk_oc"/>',
      '      </column>',
      '    </createTable>',
      '  </changeSet>',
      '</databaseChangeLog>',
    ].join('\n');
    const r = parse('changelog.xml', xml);
    const orders = r.entities.find((e) => e.name === 'orders');
    expect(orders?.columns.map((c) => c.name)).toEqual(['id', 'customer_id']);
    expect(orders?.columns.find((c) => c.name === 'id')?.primaryKey).toBe(true);
    expect(r.relations.map((x) => `${x.from.name}->${x.to.name}`)).toEqual(['orders->customers']);
  });

  it('reads the default-value variants (computed / boolean / numeric) and remarks', () => {
    const xml = [
      '<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">',
      '  <changeSet id="1" author="a">',
      '    <createTable tableName="t">',
      '      <column name="created" type="timestamp" defaultValueComputed="now()"/>',
      '      <column name="active" type="boolean" defaultValueBoolean="true"/>',
      '      <column name="score" type="int" defaultValueNumeric="0"/>',
      '      <column name="name" type="varchar(50)" defaultValue="n/a" remarks="the name"/>',
      '    </createTable>',
      '  </changeSet>',
      '</databaseChangeLog>',
    ].join('\n');
    const t = parse('changelog.xml', xml).entities.find((e) => e.name === 't');
    const by = (n: string) => t?.columns.find((c) => c.name === n);
    expect(by('created')?.default).toBe('now()');
    expect(by('active')?.default).toBe('true');
    expect(by('score')?.default).toBe('0');
    expect(by('name')?.comment).toBe('the name');
  });
});

describe('liquibase JSON', () => {
  it('reads a JSON changelog and its FK', () => {
    const json = JSON.stringify({
      databaseChangeLog: [
        {
          changeSet: {
            id: '1',
            author: 'a',
            changes: [
              {
                createTable: {
                  tableName: 'book',
                  columns: [
                    { column: { name: 'id', type: 'bigint', constraints: { primaryKey: true } } },
                    { column: { name: 'author_id', type: 'bigint', constraints: { referencedTableName: 'author', referencedColumnNames: 'id', foreignKeyName: 'fk_ba' } } },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    const r = parse('changelog.json', json);
    expect(r.entities.find((e) => e.name === 'book')?.columns.map((c) => c.name)).toEqual(['id', 'author_id']);
    expect(r.relations.map((x) => `${x.from.name}->${x.to.name}`)).toEqual(['book->author']);
  });
});

describe('liquibase — robustness', () => {
  it('never throws on truncated / malformed input in any format', () => {
    for (const bad of ['{"databaseChangeLog":', '<databaseChangeLog><changeSet', 'databaseChangeLog:\n  - changeSet:', '{bad json', '<a><b>']) {
      expect(() => parse('changelog.json', bad)).not.toThrow();
      expect(() => parse('changelog.xml', bad)).not.toThrow();
      expect(() => parse('changelog.yaml', bad)).not.toThrow();
    }
  });
});
