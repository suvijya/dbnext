/**
 * Small helpers shared by the `schemas` agent's parsers (DBML, Diesel, Liquibase) and the engine
 * detector. Pure, synchronous, no Node APIs.
 */

/** Collapses runs of whitespace to a single space and trims the ends. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Splits a comma-separated list, trims every item and drops empty ones. */
export function splitCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** Uppercases a referential action as SQL writes it (`cascade` → `CASCADE`, `set null` → `SET NULL`). */
export function normalizeAction(value: string | undefined): string | undefined {
  const v = value?.trim().replace(/\s+/g, ' ');
  return v ? v.toUpperCase() : undefined;
}
