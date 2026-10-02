import { describe, expect, it } from 'vitest';
import { sqlParser } from '../../../src/parsers/sql';

// Regressions found while scanning real repositories (RealWorld example apps).
describe('sql parser regressions', () => {
  it('ignores backticks inside comments when sniffing the dialect (Prisma migration warnings)', () => {
    const text = [
      '/*',
      '  Warnings:',
      '  - You are about to drop the `ArticleTags` table.',
      '*/',
      '-- DropForeignKey',
      'ALTER TABLE "ArticleTags" DROP CONSTRAINT "ArticleTags_articleId_fkey";',
      'CREATE TABLE "Tag" ("id" SERIAL NOT NULL, "name" TEXT NOT NULL, CONSTRAINT "Tag_pkey" PRIMARY KEY ("id"));',
    ].join('\n');
    const r = sqlParser.parse({ path: 'prisma/migrations/20211001_x/migration.sql', text });
    expect(r.engines?.map((e) => e.engine)).toEqual(['postgresql']);
  });

  it('keeps standard (non-backslash) string escapes for PostgreSQL files that mention backticks in comments', () => {
    const text = "-- see `docs`\nCREATE TABLE paths (p text DEFAULT 'C:\\'); CREATE TABLE after_it (id int PRIMARY KEY);";
    const r = sqlParser.parse({ path: 'db/schema.sql', text });
    expect(r.entities.map((e) => e.name)).toEqual(['paths', 'after_it']);
  });

  it('still detects real MySQL dumps', () => {
    const text = '/*!40101 SET NAMES utf8 */;\nCREATE TABLE `users` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `bio` text COMMENT \'it\\\'s me\',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\nCREATE TABLE `posts` (`id` int NOT NULL, PRIMARY KEY (`id`));';
    const r = sqlParser.parse({ path: 'dump.sql', text });
    expect(r.engines?.[0]?.engine).toBe('mysql');
    expect(r.entities.map((e) => e.name)).toEqual(['users', 'posts']);
  });
});
