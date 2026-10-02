import { describe, expect, it } from 'vitest';
import type { Column, FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { sqlParser } from '../../../src/parsers/sql';

const parse = (path: string, text: string) => sqlParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'sql', result: parse(path, text) });
const col = (entity: { columns: Column[] } | undefined, name: string): Column | undefined =>
  entity?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// detect()
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('detect', () => {
  it('claims .sql / .ddl / .cql files that contain DDL verbs', () => {
    expect(sqlParser.detect({ path: 'db/schema.sql', text: 'CREATE TABLE t (id int);' })).toBe(true);
    expect(sqlParser.detect({ path: 'ddl/model.ddl', text: 'alter table t add column x int;' })).toBe(true);
    expect(sqlParser.detect({ path: 'cassandra/schema.cql', text: 'CREATE TABLE t (id uuid PRIMARY KEY);' })).toBe(true);
    expect(sqlParser.detect({ path: 'drop.sql', text: 'DROP TABLE old;' })).toBe(true);
  });

  it('rejects non-SQL files and SQL without DDL verbs', () => {
    expect(sqlParser.detect({ path: 'src/app.ts', text: 'const CREATE = 1; // CREATE TABLE' })).toBe(false);
    expect(sqlParser.detect({ path: 'query.sql', text: 'SELECT * FROM users WHERE id = 1;' })).toBe(false);
    expect(sqlParser.detect({ path: 'notes.md', text: 'CREATE TABLE t (id int);' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PostgreSQL', () => {
  const sql = `
    CREATE TYPE user_status AS ENUM ('active', 'inactive', 'banned');

    CREATE TABLE users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      status user_status NOT NULL DEFAULT 'active',
      created_at timestamp with time zone DEFAULT now(),
      tags text[],
      bio text
    );

    CREATE TABLE posts (
      id bigserial PRIMARY KEY,
      author_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT,
      title text NOT NULL,
      body text
    );
  `;

  it('parses columns, serial/identity, arrays, enums and defaults', () => {
    const r = parse('db/schema.sql', sql);
    expect(r.origin).toBe('definition');
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'postgresql' }));

    const users = r.entities.find((e) => e.name === 'users')!;
    expect(users.kind).toBe('table');
    expect(users.engine).toBe('postgresql');
    expect(names(users.columns)).toEqual(['id', 'email', 'status', 'created_at', 'tags', 'bio']);
    expect(col(users, 'id')).toMatchObject({ type: 'serial', primaryKey: true, nullable: false, generated: true });
    expect(col(users, 'email')).toMatchObject({ type: 'varchar(255)', nullable: false, unique: true });
    expect(col(users, 'status')).toMatchObject({ type: 'user_status', nullable: false, default: "'active'" });
    expect(col(users, 'created_at')!.type).toBe('timestamp with time zone');
    expect(col(users, 'created_at')!.default).toBe('now()');
    expect(col(users, 'tags')).toMatchObject({ type: 'text[]', isArray: true });

    const en = r.enums.find((e) => e.name === 'user_status')!;
    expect(en.values).toEqual(['active', 'inactive', 'banned']);
  });

  it('emits inline foreign keys with cascade actions', () => {
    const r = parse('db/schema.sql', sql);
    const fk = r.relations.find((x) => x.fromColumns[0] === 'author_id')!;
    expect(fk).toMatchObject({ kind: 'foreign-key', toColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' });
    expect(fk.from.name).toBe('posts');
    expect(fk.to.name).toBe('users');
  });

  it('resolves end-to-end into the expected diagram', () => {
    const r = resolveSchema([fr('db/schema.sql', sql)]);
    expect(r.entities.map((e) => e.id)).toEqual(['posts', 'users']);
    const rel = r.relations.find((x) => x.from === 'posts')!;
    expect(rel).toMatchObject({ to: 'users', fromColumns: ['author_id'], toColumns: ['id'], cardinality: 'many-to-one', optional: false, onDelete: 'CASCADE' });
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(col(users, 'status')!.enumRef).toBe('user_status');
    expect(r.enums.map((e) => e.id)).toEqual(['user_status']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(col(posts, 'author_id')!.references).toEqual({ entity: 'users', column: 'id' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MySQL / MariaDB
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('MySQL', () => {
  const sql = `
    /*!40101 SET NAMES utf8mb4 */;
    CREATE TABLE \`orders\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`customer_id\` INT NOT NULL,
      \`status\` ENUM('new','paid','shipped') NOT NULL DEFAULT 'new',
      \`total\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`note\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
      \`created\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_customer\` (\`customer_id\`),
      CONSTRAINT \`fk_cust\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Customer orders';
  `;

  it('handles backticks, unsigned, auto_increment, inline enum and table options', () => {
    const r = parse('dump.sql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'mysql' }));
    const orders = r.entities.find((e) => e.name === 'orders')!;
    expect(orders.comment).toBe('Customer orders');
    expect(col(orders, 'id')).toMatchObject({ type: 'INT UNSIGNED', generated: true, nullable: false, primaryKey: true });
    expect(col(orders, 'total')).toMatchObject({ type: 'DECIMAL(10,2)', default: '0.00' });
    expect(col(orders, 'note')!.type).toBe('VARCHAR(255)');
    expect(col(orders, 'note')!.nullable).toBe(true);
    expect(col(orders, 'created')!.default).toBe('CURRENT_TIMESTAMP');
    expect(col(orders, 'customer_id')!.unique).toBe(true);

    const en = r.enums.find((e) => e.name === 'orders_status')!;
    expect(en.values).toEqual(['new', 'paid', 'shipped']);
    expect(col(orders, 'status')!.enumRef).toBe('orders_status');
  });

  it('emits the named composite foreign key and resolves it', () => {
    const raw = parse('dump.sql', sql);
    const fk = raw.relations[0];
    expect(fk).toMatchObject({ name: 'fk_cust', fromColumns: ['customer_id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' });

    const r = resolveSchema([fr('dump.sql', sql)]);
    const rel = r.relations.find((x) => x.from === 'orders')!;
    expect(rel.to).toBe('customers');
    expect(rel.fromColumns).toEqual(['customer_id']);
    expect(r.entities.find((e) => e.id === 'customers')!.external).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SQLite (incl. trigger body splitting + CREATE INDEX)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SQLite', () => {
  const sql = `
    CREATE TABLE "user" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "team_id" INTEGER REFERENCES "team"("id")
    );

    CREATE TABLE team (
      id INTEGER PRIMARY KEY,
      name TEXT
    ) WITHOUT ROWID;

    CREATE TRIGGER trg_user AFTER INSERT ON "user"
    BEGIN
      UPDATE team SET name = 'x' WHERE id = NEW.team_id;
      INSERT INTO audit (msg) VALUES ('created');
    END;

    CREATE INDEX idx_user_name ON "user"(name);
  `;

  it('parses quoted identifiers and survives the trigger body to reach later statements', () => {
    const r = parse('db/sqlite.sql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'sqlite' }));
    const user = r.entities.find((e) => e.name === 'user' && !e.partial)!;
    expect(col(user, 'id')).toMatchObject({ primaryKey: true, generated: true });
    expect(r.relations.find((x) => x.fromColumns[0] === 'team_id')!.to.name).toBe('team');
    // The CREATE INDEX after the trigger is still parsed (as a partial entity).
    const idx = r.entities.find((e) => e.partial && e.indexes?.length);
    expect(idx!.indexes![0]).toMatchObject({ columns: ['name'], unique: false });
  });

  it('merges the standalone index into the resolved entity', () => {
    const r = resolveSchema([fr('db/sqlite.sql', sql)]);
    const user = r.entities.find((e) => e.id === 'user')!;
    expect(user.indexes.some((ix) => ix.columns.includes('name'))).toBe(true);
    expect(r.relations.find((x) => x.from === 'user')!.to).toBe('team');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SQL Server (GO batches, [brackets], IDENTITY, WITH CHECK ADD CONSTRAINT, sp_rename)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SQL Server', () => {
  const sql = `
    CREATE TABLE [dbo].[Customers] (
      [Id] [int] IDENTITY(1,1) NOT NULL,
      [Name] [nvarchar](100) NOT NULL,
      [Email] [nvarchar](255) NULL,
      CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([Id])
    )
    GO
    CREATE TABLE [dbo].[Orders] (
      [Id] [int] IDENTITY(1,1) NOT NULL,
      [CustomerId] [int] NOT NULL,
      CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
    )
    GO
    ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerId])
    REFERENCES [dbo].[Customers] ([Id]) ON DELETE CASCADE
    GO
    EXEC sp_rename 'dbo.Orders.CustomerId', 'BuyerId', 'COLUMN'
    GO
  `;

  it('splits GO batches, unwraps brackets and reads IDENTITY + sp_rename', () => {
    const r = parse('mssql.sql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'sqlserver' }));
    const customers = r.entities.find((e) => e.name === 'Customers')!;
    expect(customers.schema).toBe('dbo');
    expect(col(customers, 'Id')).toMatchObject({ type: 'int', generated: true, nullable: false, primaryKey: true });
    expect(col(customers, 'Name')!.type).toBe('nvarchar(100)');
    expect(col(customers, 'Email')!.nullable).toBe(true);
    expect(r.ops).toContainEqual(expect.objectContaining({ op: 'renameColumn', column: 'CustomerId', to: 'BuyerId' }));
  });

  it('resolves the FK and applies the column rename (schema dbo omitted)', () => {
    const r = resolveSchema([fr('mssql.sql', sql)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['customers', 'orders']);
    const orders = r.entities.find((e) => e.id === 'orders')!;
    expect(names(orders.columns)).toContain('BuyerId');
    const rel = r.relations.find((x) => x.from === 'orders')!;
    expect(rel).toMatchObject({ to: 'customers', fromColumns: ['BuyerId'], onDelete: 'CASCADE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Oracle (VARCHAR2, NUMBER, `/` terminators)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Oracle', () => {
  const sql = `
    CREATE TABLE departments (
      dept_id NUMBER(10) PRIMARY KEY,
      name VARCHAR2(100 CHAR) NOT NULL
    );
    /
    CREATE TABLE employees (
      emp_id NUMBER(10) PRIMARY KEY,
      name VARCHAR2(100) NOT NULL,
      salary NUMBER(10,2) DEFAULT 0,
      dept_id NUMBER(10)
    );
    /
    ALTER TABLE employees ADD CONSTRAINT fk_dept FOREIGN KEY (dept_id) REFERENCES departments (dept_id);
    /
  `;

  it('reads VARCHAR2/NUMBER types, slash terminators and alter-table FKs', () => {
    const r = parse('oracle.ddl', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'oracle' }));
    const emp = r.entities.find((e) => e.name === 'employees')!;
    expect(col(emp, 'name')!.type).toBe('VARCHAR2(100)');
    expect(col(emp, 'salary')).toMatchObject({ type: 'NUMBER(10,2)', default: '0' });

    const r2 = resolveSchema([fr('oracle.ddl', sql)]);
    const rel = r2.relations.find((x) => x.from === 'employees')!;
    expect(rel).toMatchObject({ to: 'departments', fromColumns: ['dept_id'], name: 'fk_dept' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cassandra CQL
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Cassandra CQL', () => {
  it('reads collection types and composite PRIMARY KEY ((a,b),c)', () => {
    const sql = `
      CREATE TABLE user_activity (
        user_id uuid,
        activity_date date,
        activity_id timeuuid,
        details map<text, text>,
        score int,
        PRIMARY KEY ((user_id, activity_date), activity_id)
      );
    `;
    const r = parse('cassandra/schema.cql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'cassandra' }));
    const t = r.entities[0];
    expect(col(t, 'details')!.type).toBe('map<text, text>');
    const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
    expect(pk).toEqual(['user_id', 'activity_date', 'activity_id']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BigQuery
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('BigQuery', () => {
  it('splits project.dataset.table and reads STRUCT / ARRAY types', () => {
    const sql = 'CREATE TABLE `my-project.analytics.events` (\n' +
      '  event_id STRING NOT NULL,\n' +
      '  payload STRUCT<id INT64, name STRING>,\n' +
      '  tags ARRAY<STRING>,\n' +
      '  created TIMESTAMP\n' +
      ');';
    const r = parse('bq/events.sql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'bigquery' }));
    const t = r.entities[0];
    expect(t.name).toBe('events');
    expect(t.schema).toBe('analytics');
    expect(col(t, 'payload')!.type).toBe('STRUCT<id INT64, name STRING>');
    expect(col(t, 'tags')).toMatchObject({ type: 'ARRAY<STRING>', isArray: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ClickHouse
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ClickHouse', () => {
  it('detects the MergeTree engine', () => {
    const sql = `
      CREATE TABLE hits (
        id UInt64,
        url String,
        ts DateTime
      ) ENGINE = MergeTree() ORDER BY id;
    `;
    const r = parse('clickhouse.sql', sql);
    expect(r.engines).toContainEqual(expect.objectContaining({ engine: 'clickhouse' }));
    expect(names(r.entities[0].columns)).toEqual(['id', 'url', 'ts']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CREATE VIEW
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CREATE VIEW', () => {
  it('reads an explicit column list', () => {
    const r = parse('views.sql', 'CREATE VIEW v (a, b) AS SELECT 1, 2;');
    expect(r.entities[0]).toMatchObject({ name: 'v', kind: 'view' });
    expect(names(r.entities[0].columns)).toEqual(['a', 'b']);
  });

  it('reads simple select-list aliases when no column list is given', () => {
    const r = parse('views.sql', 'CREATE OR REPLACE VIEW active_users AS\nSELECT id, email AS login FROM users WHERE active = true;');
    expect(r.entities[0].kind).toBe('view');
    expect(names(r.entities[0].columns)).toEqual(['id', 'login']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Enum lifecycle (CREATE / ALTER / DROP TYPE)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('enum lifecycle', () => {
  it('creates, extends (ALTER TYPE ADD VALUE) and renames enums', () => {
    const defs = `CREATE TYPE mood AS ENUM ('ok', 'good');`;
    const mig = `ALTER TYPE mood ADD VALUE 'great';\nALTER TYPE mood RENAME TO feeling;`;
    const r1 = parse('db/schema.sql', defs);
    expect(r1.enums[0]).toMatchObject({ name: 'mood', values: ['ok', 'good'] });
    const r2 = parse('db/migrations/001_mood.sql', mig);
    expect(r2.enums[0]).toMatchObject({ name: 'mood', values: ['great'], partial: true });
    expect(r2.ops).toContainEqual(expect.objectContaining({ op: 'renameEnum', name: 'mood', to: 'feeling' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// pg_dump structure
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('pg_dump structure', () => {
  const sql = `
    CREATE TABLE public.users (
        id integer NOT NULL,
        email text NOT NULL
    );

    CREATE TABLE public.accounts (
        id integer NOT NULL,
        owner_id integer NOT NULL,
        name text
    );

    CREATE SEQUENCE public.accounts_id_seq AS integer START WITH 1 INCREMENT BY 1;

    ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);

    ALTER TABLE ONLY public.accounts
        ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

    ALTER TABLE ONLY public.accounts
        ADD CONSTRAINT accounts_owner_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;
  `;

  it('applies pg_dump ALTER TABLE ONLY default/pk/fk statements', () => {
    const r = resolveSchema([fr('structure.sql', sql)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['accounts', 'users']);
    const accounts = r.entities.find((e) => e.id === 'accounts')!;
    const id = col(accounts, 'id')!;
    expect(id.default).toBe("nextval('public.accounts_id_seq'::regclass)");
    expect(id.generated).toBe(true);
    expect(id.primaryKey).toBe(true);
    const rel = r.relations.find((x) => x.from === 'accounts')!;
    expect(rel).toMatchObject({ to: 'users', fromColumns: ['owner_id'], toColumns: ['id'], onDelete: 'CASCADE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migration conventions
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('migration conventions', () => {
  it('treats migration paths/content as migrations and Flyway undo files as empty', () => {
    expect(parse('db/migrate/001_x.sql', 'CREATE TABLE x (id int);').origin).toBe('migration');
    expect(parse('flyway/V1__init.sql', 'CREATE TABLE x (id int);').origin).toBe('migration');
    expect(parse('x.up.sql', 'CREATE TABLE x (id int);').origin).toBe('migration');
    const undo = parse('flyway/U2__drop.sql', 'DROP TABLE x;');
    expect(undo.origin).toBe('migration');
    expect(undo.entities).toHaveLength(0);
    expect(undo.ops ?? []).toHaveLength(0);
  });

  it('ignores goose Down sections', () => {
    const sql = `
      -- +goose Up
      CREATE TABLE widgets (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
      );

      -- +goose Down
      DROP TABLE widgets;
    `;
    const r = parse('db/migrations/001_create_widgets.sql', sql);
    expect(r.origin).toBe('migration');
    expect(r.entities.map((e) => e.name)).toEqual(['widgets']);
    expect(r.ops ?? []).toHaveLength(0); // the DROP in the Down section is skipped
  });

  it('ignores dbmate and sql-migrate down sections', () => {
    const dbmate = `-- migrate:up\nCREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;`;
    expect((parse('db/migrations/1_a.sql', dbmate).ops ?? [])).toHaveLength(0);
    const sqlmigrate = `-- +migrate Up\nCREATE TABLE b (id int);\n-- +migrate Down\nDROP TABLE b;`;
    expect((parse('migrations/2_b.sql', sqlmigrate).ops ?? [])).toHaveLength(0);
  });

  it('handles the Prisma SQLite redefine-table pattern across two migration files', () => {
    const init = `
      CREATE TABLE "User" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "email" TEXT NOT NULL
      );
    `;
    const alter = `
      PRAGMA foreign_keys=OFF;
      CREATE TABLE "new_User" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "email" TEXT NOT NULL,
          "name" TEXT
      );
      INSERT INTO "new_User" ("id", "email") SELECT "id", "email" FROM "User";
      DROP TABLE "User";
      ALTER TABLE "new_User" RENAME TO "User";
      PRAGMA foreign_keys=ON;
    `;
    const r = resolveSchema([
      fr('prisma/migrations/20230101000000_init/migration.sql', init),
      fr('prisma/migrations/20230102000000_add_name/migration.sql', alter),
    ]);
    const user = r.entities.find((e) => e.id === 'user')!;
    expect(user).toBeDefined();
    expect(names(user.columns)).toEqual(['id', 'email', 'name']);
    expect(r.entities.some((e) => e.id === 'new_user')).toBe(false);
  });

  it('reads a Supabase migration referencing auth.users', () => {
    const sql = `
      create table profiles (
        id uuid primary key references auth.users (id) on delete cascade,
        username text unique,
        bio text
      );
    `;
    const raw = parse('supabase/migrations/20230101000000_profiles.sql', sql);
    expect(raw.origin).toBe('migration');

    const r = resolveSchema([fr('supabase/migrations/20230101000000_profiles.sql', sql)]);
    const authUsers = r.entities.find((e) => e.id === 'auth.users')!;
    expect(authUsers.external).toBe(true);
    const rel = r.relations.find((x) => x.from === 'profiles')!;
    expect(rel).toMatchObject({ to: 'auth.users', fromColumns: ['id'], onDelete: 'CASCADE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ALTER TABLE on an existing definition
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ALTER TABLE', () => {
  const sql = `
    CREATE TABLE items (
      id int PRIMARY KEY,
      name varchar(50),
      price int
    );
    ALTER TABLE items ADD COLUMN sku varchar(20) NOT NULL;
    ALTER TABLE items ALTER COLUMN name SET NOT NULL;
    ALTER TABLE items RENAME COLUMN price TO unit_price;
    ALTER TABLE items ADD CONSTRAINT uq_sku UNIQUE (sku);
  `;

  it('adds columns, alters nullability, renames columns and adds unique indexes', () => {
    const r = resolveSchema([fr('db/schema.sql', sql)]);
    const items = r.entities.find((e) => e.id === 'items')!;
    expect(names(items.columns)).toContain('sku');
    expect(col(items, 'sku')!.nullable).toBe(false);
    expect(col(items, 'name')!.nullable).toBe(false);
    expect(names(items.columns)).toContain('unit_price');
    expect(names(items.columns)).not.toContain('price');
    expect(items.indexes.some((ix) => ix.unique && ix.columns.includes('sku'))).toBe(true);
  });

  it('expresses MySQL MODIFY and CHANGE as alter/rename ops', () => {
    const r = parse('db/migrations/003_items.sql', 'ALTER TABLE items MODIFY `name` VARCHAR(200) NOT NULL;\nALTER TABLE items CHANGE `old` `new` INT NOT NULL;');
    expect(r.ops).toContainEqual(expect.objectContaining({ op: 'alterColumn', column: 'name', set: expect.objectContaining({ type: 'VARCHAR(200)', nullable: false }) }));
    expect(r.ops).toContainEqual(expect.objectContaining({ op: 'renameColumn', column: 'old', to: 'new' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// COMMENT ON
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('COMMENT ON', () => {
  it('attaches table and column comments', () => {
    const sql = `
      CREATE TABLE books (id int PRIMARY KEY, title text);
      COMMENT ON TABLE books IS 'Library catalogue';
      COMMENT ON COLUMN books.title IS 'Full title';
    `;
    const r = resolveSchema([fr('db/schema.sql', sql)]);
    const books = r.entities.find((e) => e.id === 'books')!;
    expect(books.comment).toBe('Library catalogue');
    expect(col(books, 'title')!.comment).toBe('Full title');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Robustness: comments, look-alike strings, malformed input
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('robustness', () => {
  it('ignores commented-out DDL and SQL inside string literals', () => {
    const sql = `
      -- CREATE TABLE ghost (id int);
      /* CREATE TABLE block_ghost (y int); */
      CREATE TABLE real_t (
        id int PRIMARY KEY,
        note text DEFAULT 'CREATE TABLE not_a_table (x int)'
      );
    `;
    const r = parse('db/schema.sql', sql);
    expect(r.entities.map((e) => e.name)).toEqual(['real_t']);
    expect(col(r.entities[0], 'note')!.default).toBe("'CREATE TABLE not_a_table (x int)'");
  });

  it('never throws on malformed input and recovers to the next good statement', () => {
    const sql = `
      CREATE TABLE ( broken ;
      ALTER TABLE ;
      DROP ;
      CREATE TABLE good (id int PRIMARY KEY, label text);
    `;
    expect(() => parse('db/broken.sql', sql)).not.toThrow();
    const r = parse('db/broken.sql', sql);
    const good = r.entities.find((e) => e.name === 'good');
    expect(good).toBeDefined();
    expect(names(good!.columns)).toEqual(['id', 'label']);
  });

  it('returns an empty result (no throw) for empty input', () => {
    expect(() => parse('x.sql', '')).not.toThrow();
    expect(parse('x.sql', '').entities).toHaveLength(0);
  });
});
