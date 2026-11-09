/**
 * Named saved views ("billing tables"): a name plus a subset of entity ids, stored in the small
 * committed file `.dbnext/views.json`. Untrusted input: validated and size-limited on load; bad
 * JSON yields no views. Dependency-free (no Node APIs).
 *
 * File shape: `{ "version": 1, "views": [ { "name": "Billing", "entities": ["<entityId>", ...] } ] }`
 */

export const VIEWS_PATH = '.dbnext/views.json';

export interface SavedView {
  name: string;
  entities: string[];
}

const MAX_VIEWS = 200;
const MAX_NAME = 80;
const MAX_ENTITIES = 20_000;
const MAX_KEY_LENGTH = 1000;
const MAX_FILE_LENGTH = 8 * 1024 * 1024;

/** Accepts only the documented shape; duplicates (by name) and junk are dropped. Never throws. */
export function sanitizeViews(value: unknown): SavedView[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { views?: unknown }).views)
      ? (value as { views: unknown[] }).views
      : [];
  const out: SavedView[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (out.length >= MAX_VIEWS) break;
    const v = raw as { name?: unknown; entities?: unknown } | null;
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !Array.isArray(v.entities)) continue;
    const name = v.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name || seen.has(name.toLowerCase())) continue;
    const entities = [...new Set(v.entities.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_KEY_LENGTH))].slice(0, MAX_ENTITIES);
    seen.add(name.toLowerCase());
    out.push({ name, entities });
  }
  return out;
}

export function parseViews(text: string): SavedView[] {
  if (text.length > MAX_FILE_LENGTH) return [];
  try {
    return sanitizeViews(JSON.parse(text));
  } catch {
    return [];
  }
}

export function serializeViews(views: readonly SavedView[]): string {
  return `${JSON.stringify({ version: 1, views: sanitizeViews(views) }, null, 2)}\n`;
}
