import { describe, expect, it } from 'vitest';
import type { ParseResult, SourceKind } from '../../src/core/model';
import { parsers } from '../../src/parsers';

/** One small, realistic file per technology. */
const SAMPLES: Record<SourceKind, { path: string; text: string }> = {
  sql: { path: 'db/schema.sql', text: 'CREATE TABLE users (\n  id serial PRIMARY KEY,\n  email text NOT NULL UNIQUE\n);\n-- comment\nCREATE TABLE posts (\n  id serial PRIMARY KEY,\n  user_id int REFERENCES users(id) ON DELETE CASCADE,\n  body text DEFAULT \'a,b)\'\n);\n' },
  dbml: { path: 'schema.dbml', text: "Table users {\n  id int [pk, increment]\n  email varchar [unique, not null]\n}\nTable posts {\n  id int [pk]\n  user_id int [ref: > users.id]\n  note text [note: 'multi\n line']\n}\n" },
  diesel: { path: 'src/schema.rs', text: 'diesel::table! {\n    users (id) {\n        id -> Int4,\n        name -> Nullable<Text>,\n    }\n}\n\ndiesel::table! {\n    posts (id) {\n        id -> Int4,\n        user_id -> Int4,\n    }\n}\n\ndiesel::joinable!(posts -> users (user_id));\n' },
  liquibase: { path: 'db/changelog/db.changelog-master.yaml', text: 'databaseChangeLog:\n  - changeSet:\n      id: 1\n      author: a\n      changes:\n        - createTable:\n            tableName: users\n            columns:\n              - column:\n                  name: id\n                  type: bigint\n                  constraints:\n                    primaryKey: true\n              - column:\n                  name: email\n                  type: varchar(255)\n' },
  prisma: { path: 'prisma/schema.prisma', text: 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\n/// A user\nmodel User {\n  id    Int    @id @default(autoincrement())\n  posts Post[]\n}\n\nmodel Post {\n  id       Int  @id\n  authorId Int\n  author   User @relation(fields: [authorId], references: [id])\n}\n' },
  typeorm: { path: 'src/user.entity.ts', text: "import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';\n\n@Entity('users')\nexport class User {\n  @PrimaryGeneratedColumn()\n  id: number;\n\n  @Column({ nullable: true })\n  name?: string;\n\n  @ManyToOne(() => Team, (t) => t.users)\n  team: Team;\n}\n\n@Entity()\nexport class Team {\n  @PrimaryGeneratedColumn() id: number;\n}\n" },
  mikroorm: { path: 'src/book.entity.ts', text: "import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/core';\n\n@Entity()\nexport class Book {\n  @PrimaryKey()\n  id!: number;\n\n  @Property()\n  title!: string;\n\n  @ManyToOne(() => Author)\n  author!: Author;\n}\n\n@Entity()\nexport class Author {\n  @PrimaryKey() id!: number;\n}\n" },
  drizzle: { path: 'src/db/schema.ts', text: "import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';\n\nexport const users = pgTable('users', {\n  id: serial('id').primaryKey(),\n  name: text('name'),\n});\n\nexport const posts = pgTable('posts', {\n  id: serial('id').primaryKey(),\n  authorId: integer('author_id').notNull().references(() => users.id),\n});\n" },
  sequelize: { path: 'models/user.js', text: "const { DataTypes } = require('sequelize');\nmodule.exports = (sequelize) => {\n  const User = sequelize.define('User', {\n    name: { type: DataTypes.STRING, allowNull: false },\n  });\n  const Post = sequelize.define('Post', {\n    title: DataTypes.STRING,\n  });\n  Post.belongsTo(User);\n  return User;\n};\n" },
  mongoose: { path: 'models/user.js', text: "const mongoose = require('mongoose');\nconst userSchema = new mongoose.Schema({\n  name: { type: String, required: true },\n  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },\n}, { timestamps: true });\nmodule.exports = mongoose.model('User', userSchema);\n" },
  knex: { path: 'migrations/20240101_init.js', text: "exports.up = function (knex) {\n  return knex.schema\n    .createTable('users', (t) => {\n      t.increments('id');\n      t.string('email').notNullable();\n    })\n    .createTable('posts', (t) => {\n      t.increments('id');\n      t.integer('user_id').references('id').inTable('users');\n    });\n};\nexports.down = (knex) => knex.schema.dropTable('posts');\n" },
  kysely: { path: 'src/migrations/001_init.ts', text: "import { Kysely, sql } from 'kysely';\nexport async function up(db: Kysely<any>): Promise<void> {\n  await db.schema\n    .createTable('person')\n    .addColumn('id', 'serial', (col) => col.primaryKey())\n    .addColumn('name', 'varchar', (col) => col.notNull())\n    .execute();\n  await db.schema\n    .createTable('pet')\n    .addColumn('id', 'serial', (col) => col.primaryKey())\n    .addColumn('owner_id', 'integer', (col) => col.references('person.id'))\n    .execute();\n}\n" },
  django: { path: 'blog/models.py', text: 'from django.db import models\n\n\nclass Author(models.Model):\n    name = models.CharField(max_length=100)\n\n\nclass Post(models.Model):\n    """A post."""\n    author = models.ForeignKey(\n        Author,\n        on_delete=models.CASCADE,\n    )\n    title = models.CharField(max_length=200, null=True)\n\n    class Meta:\n        db_table = "posts"\n' },
  sqlalchemy: { path: 'app/models.py', text: 'from sqlalchemy import Column, Integer, String, ForeignKey\nfrom sqlalchemy.orm import declarative_base\n\nBase = declarative_base()\n\n\nclass User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n    name = Column(String(50))\n\n\nclass Post(Base):\n    __tablename__ = "posts"\n    id = Column(Integer, primary_key=True)\n    user_id = Column(\n        Integer,\n        ForeignKey("users.id"),\n    )\n' },
  sqlmodel: { path: 'app/models.py', text: 'from sqlmodel import Field, SQLModel\n\n\nclass Team(SQLModel, table=True):\n    id: int | None = Field(default=None, primary_key=True)\n    name: str\n\n\nclass Hero(SQLModel, table=True):\n    id: int | None = Field(default=None, primary_key=True)\n    team_id: int | None = Field(default=None, foreign_key="team.id")\n' },
  peewee: { path: 'app/models.py', text: 'from peewee import Model, CharField, ForeignKeyField\n\n\nclass User(Model):\n    username = CharField(unique=True)\n\n\nclass Tweet(Model):\n    user = ForeignKeyField(User, backref="tweets")\n    message = CharField()\n' },
  tortoise: { path: 'app/models.py', text: 'from tortoise import fields\nfrom tortoise.models import Model\n\n\nclass Team(Model):\n    id = fields.IntField(pk=True)\n    name = fields.CharField(max_length=50)\n\n\nclass Player(Model):\n    team = fields.ForeignKeyField("models.Team", related_name="players")\n' },
  rails: { path: 'db/schema.rb', text: 'ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do\n  create_table "users", force: :cascade do |t|\n    t.string "email", null: false\n    t.timestamps\n  end\n\n  create_table "posts", force: :cascade do |t|\n    t.references "user", null: false\n    t.text "body"\n  end\n\n  add_foreign_key "posts", "users"\nend\n' },
  laravel: { path: 'database/migrations/2024_01_01_000000_create_posts.php', text: "<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration {\n    public function up(): void\n    {\n        Schema::create('posts', function (Blueprint $table) {\n            $table->id();\n            $table->foreignId('user_id')->constrained()->cascadeOnDelete();\n            $table->string('title');\n        });\n    }\n};\n" },
  doctrine: { path: 'src/Entity/Post.php', text: "<?php\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\n#[ORM\\Table(name: 'posts')]\nclass Post\n{\n    #[ORM\\Id]\n    #[ORM\\GeneratedValue]\n    #[ORM\\Column]\n    private ?int $id = null;\n\n    #[ORM\\ManyToOne(targetEntity: User::class)]\n    #[ORM\\JoinColumn(nullable: false)]\n    private ?User $author = null;\n}\n" },
  ecto: { path: 'lib/app/post.ex', text: 'defmodule App.Post do\n  use Ecto.Schema\n\n  schema "posts" do\n    field :title, :string\n    belongs_to :user, App.User\n    timestamps()\n  end\nend\n' },
  gorm: { path: 'models/user.go', text: 'package models\n\nimport "gorm.io/gorm"\n\ntype User struct {\n\tgorm.Model\n\tName    string `gorm:"size:100;not null"`\n\tCompany Company\n\tCompanyID uint\n}\n\ntype Company struct {\n\tID   uint\n\tName string\n}\n' },
  ent: { path: 'ent/schema/user.go', text: 'package schema\n\nimport (\n\t"entgo.io/ent"\n\t"entgo.io/ent/schema/edge"\n\t"entgo.io/ent/schema/field"\n)\n\ntype User struct {\n\tent.Schema\n}\n\nfunc (User) Fields() []ent.Field {\n\treturn []ent.Field{\n\t\tfield.String("name"),\n\t}\n}\n\nfunc (User) Edges() []ent.Edge {\n\treturn []ent.Edge{\n\t\tedge.To("cars", Car.Type),\n\t}\n}\n' },
  bun: { path: 'models/user.go', text: 'package models\n\nimport "github.com/uptrace/bun"\n\ntype User struct {\n\tbun.BaseModel `bun:"table:users,alias:u"`\n\n\tID   int64  `bun:"id,pk,autoincrement"`\n\tName string `bun:"name,notnull"`\n}\n' },
  seaorm: { path: 'src/entity/cake.rs', text: 'use sea_orm::entity::prelude::*;\n\n#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]\n#[sea_orm(table_name = "cake")]\npub struct Model {\n    #[sea_orm(primary_key)]\n    pub id: i32,\n    pub name: String,\n}\n\n#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]\npub enum Relation {}\n' },
  jpa: { path: 'src/main/java/app/Post.java', text: 'package app;\n\nimport jakarta.persistence.*;\n\n@Entity\n@Table(name = "posts")\npublic class Post {\n    @Id\n    @GeneratedValue\n    private Long id;\n\n    @Column(nullable = false)\n    private String title;\n\n    @ManyToOne(optional = false)\n    @JoinColumn(name = "author_id")\n    private User author;\n}\n' },
  exposed: { path: 'src/main/kotlin/Tables.kt', text: 'import org.jetbrains.exposed.dao.id.IntIdTable\n\nobject Cities : IntIdTable("cities") {\n    val name = varchar("name", 50)\n}\n\nobject Users : IntIdTable("users") {\n    val name = varchar("name", 50)\n    val city = reference("city_id", Cities).nullable()\n}\n' },
  efcore: { path: 'Data/AppDbContext.cs', text: 'using Microsoft.EntityFrameworkCore;\n\nnamespace App.Data;\n\npublic class AppDbContext : DbContext\n{\n    public DbSet<Blog> Blogs { get; set; }\n    public DbSet<Post> Posts { get; set; }\n}\n\npublic class Blog\n{\n    public int BlogId { get; set; }\n    public string Url { get; set; }\n    public List<Post> Posts { get; set; }\n}\n\npublic class Post\n{\n    public int PostId { get; set; }\n    public int BlogId { get; set; }\n    public Blog Blog { get; set; }\n}\n' },
};

/** Comparable summary of a parse result (line numbers included: CRLF keeps the line count). */
function summary(r: ParseResult) {
  return {
    entities: r.entities.map((e) => ({ name: e.name, schema: e.schema, line: e.source.line, columns: e.columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey, c.unique, c.default ?? null]) })),
    relations: r.relations.map((x) => [x.from, x.fromColumns, x.to, x.toColumns, x.cardinality, x.source.line]),
    enums: r.enums.map((e) => [e.name, e.values]),
    ops: (r.ops ?? []).map((o) => o.op),
  };
}

const byKind = new Map(parsers.map((p) => [p.kind, p]));

describe('every parser on realistic input', () => {
  for (const [kind, sample] of Object.entries(SAMPLES) as [SourceKind, { path: string; text: string }][]) {
    const parser = byKind.get(kind)!;

    describe(kind, () => {
      it('detects and parses the sample', () => {
        expect(parser.detect(sample), 'detect').toBe(true);
        expect(parser.parse(sample).entities.length + parser.parse(sample).relations.length, 'output').toBeGreaterThan(0);
      });

      it('gives identical results with CRLF line endings', () => {
        const crlf = { ...sample, text: sample.text.replace(/\n/g, '\r\n') };
        expect(parser.detect(crlf)).toBe(true);
        expect(summary(parser.parse(crlf))).toEqual(summary(parser.parse(sample)));
      });

      it.skipIf(/\.ya?ml$/.test(sample.path))('gives identical results with tab indentation (YAML forbids tabs)', () => {
        const tabs = { ...sample, text: sample.text.replace(/^( {4})+/gm, (m) => '\t'.repeat(m.length / 4)) };
        const strip = (s: ReturnType<typeof summary>) => ({ ...s, entities: s.entities.map((e) => ({ ...e, columns: e.columns })) });
        expect(strip(summary(parser.parse(tabs)))).toEqual(strip(summary(parser.parse(sample))));
      });

      it('never throws on half-typed files', () => {
        const t = sample.text;
        for (let i = 1; i < t.length; i += Math.max(1, Math.floor(t.length / 60))) {
          const cut = { ...sample, text: t.slice(0, i) };
          expect(() => parser.detect(cut) && parser.parse(cut), `cut at ${i}`).not.toThrow();
        }
      });

      it('parses a ~1 MB file quickly', () => {
        const big = { ...sample, text: sample.text.repeat(Math.ceil(1_000_000 / sample.text.length)) };
        const t0 = Date.now();
        parser.parse(big);
        expect(Date.now() - t0, `${kind}: ${big.text.length} chars`).toBeLessThan(3000);
      });
    });
  }
});


describe('Code.closing on large and unbalanced input', () => {
  it('matches brackets per kind and stays linear when many brackets are unclosed', async () => {
    const { Code } = await import('../../src/core/text');
    const c = new Code('f(a[1], { b: (2) }) <x<y>> => z', 'js');
    expect(c.closing(1)).toBe(18);
    expect(c.closing(3)).toBe(5);
    expect(c.closing(8)).toBe(17);
    expect(c.closing(20)).toBe(25);
    expect(c.closing(0)).toBe(-1);
    const half = new Code('foo('.repeat(100_000), 'js'); // half-typed file: 100k unclosed calls
    const t0 = Date.now();
    for (let i = 3; i < half.text.length; i += 4) expect(half.closing(i)).toBe(-1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
