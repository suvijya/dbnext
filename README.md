# DBNext – Database Map & ER Diagram

**Open any repository and instantly see its databases.** DBNext scans the project, finds every
schema definition (SQL, migrations and ORM models in 33 technologies), and draws an interactive
entity-relationship map. You don't need a database connection or any configuration.

![DB Map of a Prisma shop schema: the selected table's side panel shows notes, columns and how each relation was derived, with an inferred relation drawn dashed](media/screenshot.png)

## Features

- **Automatic.** Every workspace is scanned when it opens. The status bar shows what was found and
  the map opens the first time a schema is detected.
- **Works across stacks.** One map for the SQL migrations, the ORM models and the MongoDB
  collections of a repository, merged into a single schema.
- **Interactive ER diagram.** Pan, zoom and drag tables. Search tables and columns, filter by schema,
  source or database, and switch to "focus mode" to see one table and its neighbours.
  Double-click a table to jump to its definition.
- **Relations.** Foreign keys, ORM associations, many-to-many join tables and relations inferred
  from naming conventions (`user_id` → `users.id`, drawn dashed).
- **Databases detected.** PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, Redis and more, found
  through docker compose files, dependencies and example config such as `.env.example`. Only image,
  package and URL-scheme names are shown, never hosts, usernames or passwords, and real `.env` files
  are never opened.
- **Sidebar tree.** Databases, tables, columns, relations and enums, with "Go to Definition".
- **Shows its work.** For every table, column and relation the side panel and tooltips show how DBNext derived it (declared foreign key, ORM association, inferred from naming, guessed table name) and which files and lines it came from. Uncertain items are badged so you know what to double-check.
- **Schema diff.** Compare the current schema with any branch, tag or commit and see added, removed and changed tables, columns and relations.
- **Notes.** Add your own notes to tables and columns; they are saved in `.dbnext/notes.json` so the team can share them.
- **Export.** Write a `DBMAP.md` with a Mermaid ER diagram that GitHub and GitLab render, copy the
  Mermaid, DBML or PlantUML source, or save the diagram as SVG or PNG.
- **Live.** Edit a model or add a migration and the map updates.
- **Large schemas.** 300+ tables lay out in well under a second; big schemas start with compact
  cards.

![The 100-table cal.com Prisma schema focused on the Booking table](media/screenshot-large.png)

![Schema diff view: added, removed and changed tables, columns, relations and enums](media/screenshot-diff.png)

## Supported technologies

| Ecosystem | Sources |
|---|---|
| SQL | `CREATE`/`ALTER` DDL for PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, CockroachDB, ClickHouse, BigQuery, Cassandra CQL; migration folders (Flyway, Prisma, Supabase, goose, dbmate, golang-migrate…), schema dumps |
| Schema languages | DBML, Liquibase (XML / YAML / JSON), Diesel `schema.rs` |
| JavaScript / TypeScript | Prisma, TypeORM, MikroORM, Drizzle, Sequelize (incl. sequelize-typescript & migrations), Mongoose (incl. NestJS), Knex (+ Objection), Kysely |
| Python | Django, SQLAlchemy (incl. Flask-SQLAlchemy & Alembic), SQLModel, Peewee, Tortoise ORM |
| Ruby / PHP / Elixir | Rails (`schema.rb`, migrations, models), Laravel (migrations & Eloquent), Doctrine, Ecto |
| Go / Rust | GORM, Ent, Bun, SeaORM |
| Mappings & API schemas | Hibernate XML (*.hbm.xml), Doctrine XML/YAML, GraphQL SDL (only types with a database directive such as @model), ZenStack schema.zmodel, MongoDB `$jsonSchema` validators in `createCollection` |
| JVM / .NET | JPA / Hibernate (Java & Kotlin), Exposed, Entity Framework Core (models, DbContext, migrations, snapshots) |

## Commands

| Command | |
|---|---|
| `DBNext: Open DB Map` | Open the interactive diagram |
| `DBNext: Rescan Workspace` | Scan again from scratch |
| `DBNext: Export DB Map to Markdown (Mermaid)` | Write `DBMAP.md` (path configurable) |
| `DBNext: Copy Mermaid ER Diagram` | Copy an `erDiagram` to the clipboard |
| `DBNext: Copy DBML` / `Copy PlantUML ER Diagram` | Copy the schema as DBML or PlantUML |
| `DBNext: Export DB Map as PNG` | Save the diagram as a PNG image |
| `DBNext: Select Saved View` | Show only a named subset of tables (see below) |
| `DBNext: Compare with Git Ref…` / `Copy Schema Diff as Markdown` | Diff the current schema against a branch, tag or commit; copy the diff as Markdown |
| `DBNext: Compare with Live Database (read-only)` / `Forget Live Database Password` | Opt-in, desktop only (see below) |
| `DBNext: Show Scan Log` | What was scanned, found and skipped |

### Saved views

In the map, arrange the filters/search so only the tables you care about are visible, open **Views**, type a name
(for example "billing") and press **Save view**. Views are stored in `.dbnext/views.json` (commit it to share them) and
are selectable from the toolbar or `DBNext: Select Saved View`. Export > Copy Mermaid/DBML/PlantUML honour the active view.

### Notes

Select a table in the map to add a note. Notes are stored in `.dbnext/notes.json` and included in exports.

### Live database comparison (opt-in)

Set `dbnext.liveDatabase.enabled` (machine scope, desktop only, off by default) plus engine (PostgreSQL or MySQL/MariaDB), host, port, database and user. `DBNext: Compare with Live Database` runs read-only catalog queries and shows the differences from the code-derived model. The password is kept in VS Code SecretStorage, never in settings. Use a read-only account.

## Command line (CI)

The same scanner is available as a CLI, e.g. to keep `DBMAP.md` up to date in CI:

The CLI is not published to npm (the `dbnext` package name on npm belongs to an unrelated project, so do not run `npx dbnext`). Build it from a clone of this repository:

```sh
git clone https://github.com/suvijya/dbnext && cd dbnext
npm ci && npm run build:prod
node dist/cli.js scan /path/to/project --out DBMAP.md           # Markdown + Mermaid (default)
node dist/cli.js scan /path/to/project --format dbml            # md | mermaid | dbml | plantuml | json
```

`dist/cli.js` is not part of the extension package (`.vsix`).

Keyboard shortcuts in the map: `+` / `-` zoom, `0` fit, `F` focus the selection, `Esc` clear,
`Enter` / `Shift+Enter` cycle through search results, arrow keys move between connected tables.

## Settings

| Setting | Default | |
|---|---|---|
| `dbnext.autoOpen` | `firstTime` | Open the map automatically: `firstTime`, `always` or `never` |
| `dbnext.inferRelations` | `true` | Infer relations from column names |
| `dbnext.exclude` | `[]` | Extra glob patterns to skip (dependencies, build output and tests are skipped already) |
| `dbnext.disabledSources` | `[]` | Technologies to ignore, e.g. `["mongoose"]` |
| `dbnext.maxFiles` | `5000` | Maximum files read per scan (schema-looking files are read first) |
| `dbnext.maxFileSizeKB` | `2048` | Skip larger files |
| `dbnext.watch` | `true` | Update when schema files change |
| `dbnext.statusBar` | `true` | Show the status bar summary |
| `dbnext.export.path` | `DBMAP.md` | Workspace-relative Markdown export path |
| `dbnext.export.autoUpdate` | `false` | Rewrite the exported file after each scan (only when it already exists) |

## How it works

DBNext reads source files and, unless you enable the opt-in live database comparison, never connects to a database. Each file is parsed by a lightweight
parser for its technology. The results are merged: migrations are replayed in order, current model
definitions win over the migration history, and ORM naming conventions decide the real table and
column names. Everything runs locally inside VS Code and nothing is sent anywhere. The extension
works in untrusted workspaces and also ships a web build for vscode.dev / github.dev (not yet tested
there).

Since DBNext reads code instead of a live database, a schema that is assembled dynamically at
runtime may come out incomplete. The sidebar tree and the map's side panel show where each table is
defined, and **DBNext: Show Scan Log** lists what was scanned, the technologies found and any
warnings. Issues and sample repositories that map incorrectly are welcome on
[GitHub](https://github.com/suvijya/dbnext/issues).

## License

[MIT](LICENSE)
