/**
 * Parser registry: every schema parser plus the database-engine detector.
 *
 * Order matters only for display/tie-breaking: parsers are run independently on every file they
 * claim (via `extensions`, optional `filePatterns` and `detect`), and the resolver merges results.
 */

import type { SchemaParser } from '../core/parser';
import type { ParserRegistry } from '../core/scan';
import { bunParser } from './bun';
import { dbmlParser } from './dbml';
import { dieselParser } from './diesel';
import { djangoParser } from './django';
import { doctrineParser } from './doctrine';
import { drizzleParser } from './drizzle';
import { ectoParser } from './ecto';
import { efcoreParser } from './efcore';
import { engineDetector } from './engines';
import { entParser } from './ent';
import { exposedParser } from './exposed';
import { gormParser } from './gorm';
import { jpaParser } from './jpa';
import { knexParser } from './knex';
import { kyselyParser } from './kysely';
import { laravelParser } from './laravel';
import { liquibaseParser } from './liquibase';
import { mikroormParser } from './mikroorm';
import { mongooseParser } from './mongoose';
import { peeweeParser } from './peewee';
import { prismaParser } from './prisma';
import { railsParser } from './rails';
import { seaormParser } from './seaorm';
import { sequelizeParser } from './sequelize';
import { sqlParser } from './sql';
import { sqlalchemyParser } from './sqlalchemy';
import { sqlmodelParser } from './sqlmodel';
import { tortoiseParser } from './tortoise';
import { typeormParser } from './typeorm';

export const parsers: readonly SchemaParser[] = [
  // Schema languages and migrations
  sqlParser,
  dbmlParser,
  dieselParser,
  liquibaseParser,
  // JavaScript / TypeScript
  prismaParser,
  typeormParser,
  mikroormParser,
  drizzleParser,
  sequelizeParser,
  mongooseParser,
  knexParser,
  kyselyParser,
  // Python
  djangoParser,
  sqlalchemyParser,
  sqlmodelParser,
  peeweeParser,
  tortoiseParser,
  // Ruby / PHP / Elixir
  railsParser,
  laravelParser,
  doctrineParser,
  ectoParser,
  // Go / Rust
  gormParser,
  entParser,
  bunParser,
  seaormParser,
  // JVM / .NET
  jpaParser,
  exposedParser,
  efcoreParser,
];

export const registry: ParserRegistry = { parsers, engines: engineDetector };
