import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { prismaParser } from '../../../src/parsers/prisma';
import { sqlParser } from '../../../src/parsers/sql';

const prisma = (text: string, path = 'prisma/schema.prisma'): FileResult => ({ file: path, kind: 'prisma', result: prismaParser.parse({ path, text }) });
const sql = (text: string, path: string): FileResult => ({ file: path, kind: 'sql', result: sqlParser.parse({ path, text }) });

describe('prisma: table name certainty', () => {
  const schema = `
    model Booking {
      id Int @id
    }
    model Legacy {
      id Int @id
      @@map("legacy_rows")
    }
  `;

  it('does not flag a model without @@map as guessed', () => {
    const r = resolveSchema([prisma(schema)]);
    const booking = r.entities.find((e) => e.name === 'Booking')!;
    expect(booking.provenance?.derivation).toBe('declared');
    expect(booking.provenance?.confidence).toBe('high');
  });

  it('treats a model with @@map as declared', () => {
    const r = resolveSchema([prisma(schema)]);
    const legacy = r.entities.find((e) => e.name === 'legacy_rows')!;
    expect(legacy.provenance?.derivation).toBe('declared');
  });

  it('merges a model with the migration table of the same name into one entity', () => {
    const migration = 'CREATE TABLE "Booking" ("id" SERIAL NOT NULL, CONSTRAINT "Booking_pkey" PRIMARY KEY ("id"));';
    const r = resolveSchema([prisma(schema), sql(migration, 'prisma/migrations/1_init/migration.sql')]);
    expect(r.entities.filter((e) => e.name.toLowerCase() === 'booking')).toHaveLength(1);
    expect(r.entities.find((e) => e.name === 'Booking')?.provenance?.derivation).toBe('declared');
  });
});