# Changelog

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
