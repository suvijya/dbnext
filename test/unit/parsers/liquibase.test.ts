import { describe, expect, it } from 'vitest';
import type { FileResult, SchemaOp } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { liquibaseParser } from '../../../src/parsers/liquibase';

const parse = (text: string, path: string) => liquibaseParser.parse({ path, text });
const fr = (text: string, path: string): FileResult => ({ file: path, kind: 'liquibase', result: parse(text, path) });

describe('liquibase detect', () => {
  it('matches changelogs and rejects unrelated XML/YAML', () => {
    expect(liquibaseParser.detect({ path: 'db.changelog.xml', text: '<databaseChangeLog></databaseChangeLog>' })).toBe(true);
    expect(liquibaseParser.detect({ path: 'c.yaml', text: 'databaseChangeLog:\n  - changeSet: {}' })).toBe(true);
    expect(liquibaseParser.detect({ path: 'beans.xml', text: '<beans><bean id="x"/></beans>' })).toBe(false);
    expect(liquibaseParser.detect({ path: 'pom.xml', text: '<project></project>' })).toBe(false);
  });

  it('declares extensions and changelog file patterns', () => {
    expect(liquibaseParser.extensions).toEqual(['.xml', '.yaml', '.yml', '.json']);
    expect(liquibaseParser.filePatterns).toContain('**/db/changelog/**/*.{xml,yaml,yml,json}');
  });
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="me">
    <createTable tableName="users">
      <column name="id" type="bigint" autoIncrement="true">
        <constraints primaryKey="true" nullable="false"/>
      </column>
      <column name="email" type="varchar(255)" remarks="login">
        <constraints nullable="false" unique="true"/>
      </column>
    </createTable>
  </changeSet>
  <changeSet id="2" author="me">
    <createTable tableName="posts">
      <column name="id" type="bigint">
        <constraints primaryKey="true"/>
      </column>
      <column name="author_id" type="bigint">
        <constraints nullable="false" referencedTableName="users" referencedColumnNames="id" foreignKeyName="fk_posts_author" deleteCascade="true"/>
      </column>
      <column name="title" type="varchar(200)"/>
    </createTable>
  </changeSet>
  <changeSet id="3" author="me">
    <addColumn tableName="users">
      <column name="age" type="int"/>
    </addColumn>
    <createIndex tableName="users" indexName="idx_email" unique="true">
      <column name="email"/>
    </createIndex>
    <rollback>
      <dropColumn tableName="users" columnName="age"/>
    </rollback>
  </changeSet>
  <changeSet id="4" author="me">
    <renameColumn tableName="posts" oldColumnName="title" newColumnName="headline"/>
    <modifyDataType tableName="posts" columnName="headline" newDataType="text"/>
  </changeSet>
</databaseChangeLog>`;

describe('liquibase XML', () => {
  it('marks the result as a migration and produces create/alter changes', () => {
    const r = parse(XML, 'src/main/resources/db/changelog/db.changelog.xml');
    expect(r.origin).toBe('migration');
    expect(r.entities.find((e) => e.name === 'users' && !e.partial)!.columns.map((c) => c.name)).toEqual(['id', 'email']);
    const ops = r.ops ?? [];
    expect(ops.some((o: SchemaOp) => o.op === 'renameColumn')).toBe(true);
    expect(ops.some((o: SchemaOp) => o.op === 'alterColumn')).toBe(true);
  });

  it('end-to-end: replays the migration, honours rollback-ignore and FK direction', () => {
    const r = resolveSchema([fr(XML, 'db/changelog/db.changelog.xml')]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']);

    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.columns.map((c) => c.name).sort()).toEqual(['age', 'email', 'id']); // age added, NOT dropped (rollback ignored)
    expect(users.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, generated: true });
    expect(users.columns.find((c) => c.name === 'email')).toMatchObject({ unique: true, nullable: false, comment: 'login' });
    expect(users.indexes.some((i) => i.unique && i.columns.includes('email'))).toBe(true);

    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(posts.columns.map((c) => c.name)).toEqual(['id', 'author_id', 'headline']); // title renamed
    expect(posts.columns.find((c) => c.name === 'headline')!.type).toBe('text'); // modifyDataType

    const rel = r.relations.find((x) => x.from === 'posts' && x.to === 'users')!;
    expect(rel).toMatchObject({ fromColumns: ['author_id'], toColumns: ['id'], cardinality: 'many-to-one', onDelete: 'CASCADE', optional: false });
  });
});

const YAML = `databaseChangeLog:
  - changeSet:
      id: 10
      author: dev
      changes:
        - createTable:
            tableName: customers
            columns:
              - column:
                  name: id
                  type: bigint
                  constraints:
                    primaryKey: true
                    nullable: false
              - column:
                  name: email
                  type: varchar(255)
        - createTable:
            tableName: orders
            columns:
              - column:
                  name: id
                  type: bigint
                  constraints:
                    primaryKey: true
              - column:
                  name: customer_id
                  type: bigint
  - changeSet:
      id: 11
      author: dev
      changes:
        - addForeignKeyConstraint:
            baseTableName: orders
            baseColumnNames: customer_id
            referencedTableName: customers
            referencedColumnNames: id
            constraintName: fk_orders_customer
            onDelete: CASCADE
        - addUniqueConstraint:
            tableName: customers
            columnNames: email
            constraintName: uq_customers_email
        - createView:
            viewName: active_customers
`;

describe('liquibase YAML', () => {
  it('parses nested maps/lists and the main change types', () => {
    const r = resolveSchema([fr(YAML, 'db/changelog/0001-init.yaml')]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['active_customers', 'customers', 'orders']);

    const view = r.entities.find((e) => e.id === 'active_customers')!;
    expect(view.kind).toBe('view');

    const customers = r.entities.find((e) => e.id === 'customers')!;
    expect(customers.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(customers.indexes.some((i) => i.unique && i.columns.includes('email'))).toBe(true);

    const rel = r.relations.find((x) => x.from === 'orders' && x.to === 'customers')!;
    expect(rel).toMatchObject({ fromColumns: ['customer_id'], toColumns: ['id'], cardinality: 'many-to-one', onDelete: 'CASCADE' });
  });
});

const JSON_LOG = `{
  "databaseChangeLog": [
    { "changeSet": { "id": "20", "author": "x", "changes": [
      { "createTable": { "tableName": "tags", "columns": [
        { "column": { "name": "id", "type": "int", "constraints": { "primaryKey": true, "nullable": false } } },
        { "column": { "name": "label", "type": "varchar(50)" } }
      ] } } ]
    } }
  ]
}`;

describe('liquibase JSON', () => {
  it('parses JSON changelogs', () => {
    const result = parse(JSON_LOG, 'db/changelog/tags.json');
    expect(result.origin).toBe('migration');
    const r = resolveSchema([fr(JSON_LOG, 'db/changelog/tags.json')]);
    const tags = r.entities.find((e) => e.id === 'tags')!;
    expect(tags.columns.map((c) => c.name)).toEqual(['id', 'label']);
    expect(tags.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, nullable: false });
  });
});

describe('liquibase robustness', () => {
  it('does not throw on malformed input', () => {
    expect(() => parse('<databaseChangeLog><changeSet><createTable tableName=', 'c.xml')).not.toThrow();
    expect(() => parse('{ "databaseChangeLog": [ bad json', 'c.json')).not.toThrow();
    expect(() => parse('databaseChangeLog:\n  - changeSet:\n   bad: : :', 'c.yaml')).not.toThrow();
    expect(parse('{ "databaseChangeLog": [ bad json', 'c.json').entities).toEqual([]);
  });

  it('ignores include/includeAll and comments', () => {
    const xml = `<databaseChangeLog>
      <include file="other.xml"/>
      <includeAll path="changes/"/>
      <!-- <createTable tableName="ghost"/> -->
      <changeSet id="1"><createTable tableName="real"><column name="id" type="int"/></createTable></changeSet>
    </databaseChangeLog>`;
    const r = parse(xml, 'db/changelog/master.xml');
    expect(r.entities.map((e) => e.name)).toEqual(['real']);
  });
});
