import { describe, expect, it } from 'vitest';
import { doctrinemapParser } from '../../../src/parsers/doctrinemap';
import { graphqlParser } from '../../../src/parsers/graphql';
import { hibernateParser } from '../../../src/parsers/hibernate';
import { mongovalidatorParser } from '../../../src/parsers/mongovalidator';
import { zmodelParser } from '../../../src/parsers/zmodel';
import { parsers } from '../../../src/parsers';

const names = (r: { entities: { name: string }[] }) => r.entities.map((e) => e.name);

describe('hibernate hbm.xml', () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE hibernate-mapping PUBLIC "-//Hibernate/Hibernate Mapping DTD 3.0//EN" "http://hibernate.org/dtd/hibernate-mapping-3.0.dtd">
<hibernate-mapping schema="shop">
  <class name="com.acme.Order" table="ORDERS">
    <id name="id" column="ORDER_ID" type="long"><generator class="native"/></id>
    <property name="total" type="big_decimal" not-null="true"/>
    <property name="note"><column name="NOTE" length="200"/></property>
    <many-to-one name="customer" class="com.acme.Customer" column="CUSTOMER_ID" not-null="true"/>
    <set name="items" table="ORDER_ITEMS"><key column="ORDER_ID"/><one-to-many class="com.acme.Item"/></set>
    <joined-subclass name="com.acme.RushOrder" table="RUSH_ORDERS"><key column="ORDER_ID"/><property name="deadline"/></joined-subclass>
  </class>
  <class name="com.acme.Customer"><id name="id"/></class>
</hibernate-mapping>`;
  const file = { path: 'Order.hbm.xml', text: xml };

  it('reads classes, columns, keys and relations', () => {
    const r = hibernateParser.parse(file);
    expect(names(r)).toEqual(['ORDERS', 'RUSH_ORDERS', 'Customer']);
    const order = r.entities[0];
    expect(order.schema).toBe('shop');
    expect(order.modelName).toBe('Order');
    expect(order.columns.map((c) => [c.name, c.primaryKey, c.nullable])).toEqual([
      ['ORDER_ID', true, false],
      ['total', false, false],
      ['NOTE', false, true],
      ['CUSTOMER_ID', false, false],
    ]);
    expect(order.columns[2].type).toBe('varchar(200)');
    expect(r.relations.find((x) => x.to.model === 'Customer')?.fromColumns).toEqual(['CUSTOMER_ID']);
    expect(r.relations.find((x) => x.cardinality === 'one-to-many')?.toColumns).toEqual(['ORDER_ID']);
    expect(r.entities[1].columns.map((c) => c.name)).toEqual(['ORDER_ID', 'deadline']);
  });

  it('does not claim other XML', () => {
    expect(hibernateParser.detect({ path: 'a.hbm.xml', text: '<databaseChangeLog/>' })).toBe(false);
    expect(hibernateParser.detect({ path: 'a.hbm.xml', text: '<doctrine-mapping><entity name="A"/></doctrine-mapping>' })).toBe(false);
  });
});

describe('doctrine XML / YAML mappings', () => {
  it('reads XML entities', () => {
    const text = `<doctrine-mapping>
  <entity name="App\\Entity\\Article" table="articles">
    <id name="id" type="integer"><generator strategy="AUTO"/></id>
    <field name="title" type="string" length="120"/>
    <field name="body" type="text" nullable="true"/>
    <many-to-one field="author" target-entity="App\\Entity\\User"><join-column name="author_id" nullable="false" on-delete="CASCADE"/></many-to-one>
    <many-to-many field="tags" target-entity="Tag"><join-table name="article_tags"/></many-to-many>
    <unique-constraints><unique-constraint columns="title" name="uq_title"/></unique-constraints>
  </entity>
</doctrine-mapping>`;
    const r = doctrinemapParser.parse({ path: 'Article.orm.xml', text });
    const e = r.entities[0];
    expect(e.name).toBe('articles');
    expect(e.modelName).toBe('Article');
    expect(e.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ['id', 'integer', false],
      ['title', 'string(120)', false],
      ['body', 'text', true],
    ]);
    expect(e.indexes?.[0]).toMatchObject({ columns: ['title'], unique: true });
    const many = r.relations.find((x) => x.cardinality === 'many-to-one')!;
    expect(many.fromColumns).toEqual(['author_id']);
    expect(many.onDelete).toBe('CASCADE');
    expect(r.relations.find((x) => x.cardinality === 'many-to-many')?.through?.name).toBe('article_tags');
  });

  it('reads YAML entities', () => {
    const text = `App\\Entity\\User:
  type: entity
  table: users # comment
  id:
    id:
      type: integer
      generator: { strategy: AUTO }
  fields:
    email:
      type: string
      length: 180
      unique: true
  manyToOne:
    team:
      targetEntity: Team
      joinColumn:
        name: team_id
        referencedColumnName: id
`;
    const r = doctrinemapParser.parse({ path: 'User.dcm.yml', text });
    expect(r.entities[0].name).toBe('users');
    expect(r.entities[0].columns.map((c) => [c.name, c.type, c.primaryKey, c.unique])).toEqual([
      ['id', 'integer', true, false],
      ['email', 'string(180)', false, true],
    ]);
    expect(r.relations[0]).toMatchObject({ fromColumns: ['team_id'], toColumns: ['id'], to: { model: 'Team' } });
  });

  it('does not claim Liquibase, Hibernate or unrelated YAML', () => {
    expect(doctrinemapParser.detect({ path: 'db/changelog/a.xml', text: '<databaseChangeLog/>' })).toBe(false);
    expect(doctrinemapParser.detect({ path: 'a.hbm.xml', text: '<hibernate-mapping/>' })).toBe(false);
    expect(doctrinemapParser.detect({ path: 'docker-compose.yml', text: 'services:\n  db:\n    image: postgres\n' })).toBe(false);
    expect(doctrinemapParser.detect({ path: 'changelog.yml', text: 'databaseChangeLog:\n  - changeSet:\n      type: entity\n' })).toBe(false);
  });
});

describe('graphql SDL', () => {
  it('skips schemas without a database directive', () => {
    const text = 'type Query { users: [User!]! }\ntype User { id: ID! name: String }\n';
    expect(graphqlParser.detect({ path: 'api.graphql', text })).toBe(false);
    expect(graphqlParser.parse({ path: 'api.graphql', text }).entities).toEqual([]);
  });

  it('turns @model types into entities with relations', () => {
    const text = `"""A user"""
type User @model @table(name: "app_users") {
  id: ID!
  email: String! @unique
  nick: String @column(name: "nickname")
  role: Role
  tags: [String!]
  posts: [Post!]! @hasMany
}
enum Role { ADMIN USER }
type Post @model {
  id: ID!
  title: String!
  author: User! # who wrote it
}
type Dto { id: ID! }
`;
    const r = graphqlParser.parse({ path: 'schema.graphql', text });
    expect(names(r)).toEqual(['app_users', 'Post']);
    const user = r.entities[0];
    expect(user.columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey, c.isArray ?? false])).toEqual([
      ['id', 'ID', false, true, false],
      ['email', 'String', false, false, false],
      ['nickname', 'String', true, false, false],
      ['role', 'Role', true, false, false],
      ['tags', 'String', true, false, true],
    ]);
    expect(r.relations).toHaveLength(1); // posts list is skipped: Post has a back reference
    expect(r.relations[0]).toMatchObject({ from: { name: 'Post' }, fromColumns: ['authorId'], to: { model: 'User' }, optional: false });
    expect(r.enums[0]).toMatchObject({ name: 'Role', values: ['ADMIN', 'USER'] });
  });
});

describe('zmodel', () => {
  const text = `datasource db {
  provider = "sqlite"
  url = "file:dev.db"
}
abstract model Base {
  id Int @id
  createdAt DateTime @default(now())
}
model User extends Base {
  email String @unique
  @@allow('all', auth() == this)
}
`;
  it('handles extends, abstract models and policy attributes', () => {
    const r = zmodelParser.parse({ path: 'schema.zmodel', text });
    const user = r.entities.find((e) => e.modelName === 'User')!;
    expect(user.extends).toEqual(['Base']);
    expect(user.columns.map((c) => c.name)).toEqual(['email']);
    expect(r.entities.find((e) => e.modelName === 'Base')?.abstract).toBe(true);
    expect(user.source.line).toBe(8);
  });
});

describe('mongodb $jsonSchema validators', () => {
  it('reads createCollection validators', () => {
    const text = `await db.createCollection('orders', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      description: 'Customer orders',
      required: ['total', 'customerId'],
      properties: {
        total: { bsonType: ['double', 'null'] },
        customerId: { bsonType: 'objectId' },
        lines: { bsonType: 'array', items: { bsonType: 'object', properties: { sku: { bsonType: 'string' } } } },
        status: { enum: ['new', 'paid'] },
      },
    },
  },
});
db.createCollection("plain");
`;
    const r = mongovalidatorParser.parse({ path: 'init.js', text });
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'orders', kind: 'collection', comment: 'Customer orders', engine: 'mongodb' });
    const col = (n: string) => e.columns.find((c) => c.name === n)!;
    expect(col('_id').primaryKey).toBe(true);
    expect(col('total')).toMatchObject({ type: 'double', nullable: true });
    expect(col('customerId')).toMatchObject({ type: 'objectId', nullable: false });
    expect(col('lines')).toMatchObject({ isArray: true, type: 'object' });
    expect(col('lines.sku').type).toBe('string');
    expect(col('status').type).toBe('enum');
  });

  it('does not claim mongoose files or plain createCollection', () => {
    expect(mongovalidatorParser.detect({ path: 'a.js', text: "const s = new mongoose.Schema({ a: String });" })).toBe(false);
    expect(mongovalidatorParser.detect({ path: 'a.js', text: "db.createCollection('x')" })).toBe(false);
  });
});

describe('new parsers do not claim each other', () => {
  const samples: [string, string][] = [
    ['a.hbm.xml', '<hibernate-mapping><class name="A"/></hibernate-mapping>'],
    ['a.orm.xml', '<doctrine-mapping><entity name="A"/></doctrine-mapping>'],
    ['a.graphql', 'type A @model { id: ID! }'],
    ['a.zmodel', 'model A { id Int @id }'],
  ];
  it('claims only its own technology', () => {
    const xmlParsers = parsers.filter((p) => p.extensions.includes('.xml'));
    expect(xmlParsers.filter((p) => p.detect({ path: samples[0][0], text: samples[0][1] })).map((p) => p.kind)).toEqual(['hibernate']);
    expect(xmlParsers.filter((p) => p.detect({ path: samples[1][0], text: samples[1][1] })).map((p) => p.kind)).toEqual(['doctrinemap']);
    expect(parsers.filter((p) => p.extensions.includes('.graphql') && p.detect({ path: samples[2][0], text: samples[2][1] })).map((p) => p.kind)).toEqual(['graphql']);
  });
});
