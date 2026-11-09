# Changelog

## 0.2.0

- New parsers: Hibernate XML mappings (`*.hbm.xml`), Doctrine XML/YAML mappings, GraphQL SDL (types with a
  database directive such as `@model`), ZenStack `schema.zmodel` and MongoDB `createCollection` validators.
- Export: copy DBML and PlantUML, export the diagram as PNG.
- Saved views (`.dbnext/views.json`) and table notes (`.dbnext/notes.json`); exports honour the active view.
- Schema diff against a Git ref, with a diff view in the map and "Copy Schema Diff as Markdown".
- Opt-in, read-only live database comparison for PostgreSQL and MySQL/MariaDB (desktop only, password in SecretStorage).
- Source provenance details, "Get started" walkthrough and accessibility improvements.
- Command line: `dbnext scan <dir> --format md|mermaid|dbml|plantuml|json` (repository only, not in the `.vsix`).
## 0.1.0

First release.

- Scans the workspace automatically and maps database schemas from SQL / migrations, DBML,
  Liquibase, Diesel, Prisma, TypeORM, MikroORM, Drizzle, Sequelize, Mongoose, Knex, Kysely, Django,
  SQLAlchemy / Alembic, SQLModel, Peewee, Tortoise ORM, Rails, Laravel, Doctrine, Ecto, GORM, Ent,
  Bun, SeaORM, JPA / Hibernate, Exposed and Entity Framework Core.
- Detects the databases in use from docker compose files, dependencies and configuration.
- Interactive ER diagram with search, filters, focus mode, minimap and SVG export.
- Schema tree in the sidebar, status bar summary and "Go to Definition".
- Markdown + Mermaid export (`DBMAP.md`) and Copy Mermaid.
