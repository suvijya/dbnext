/**
 * Pure search over tables and columns: substring + subsequence (fuzzy) matching with highlight
 * ranges and a relevance score. No DOM — unit tested in test/unit/webview.
 */

import type { Entity } from '../core/model';
import { qualifiedName } from '../core/format';

export interface SearchItem {
  entityId: string;
  /** Lower-cased haystack actually matched against. */
  haystack: string;
  /** Human label shown in results. */
  label: string;
  kind: 'table' | 'column';
  /** Column name when `kind === 'column'`. */
  column?: string;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  item: SearchItem;
  score: number;
  ranges: MatchRange[];
}

/** Builds the searchable items (one per table name and one per column) for a model. */
export function buildSearchItems(entities: readonly Entity[]): SearchItem[] {
  const items: SearchItem[] = [];
  for (const e of entities) {
    const name = qualifiedName(e);
    items.push({ entityId: e.id, haystack: name.toLowerCase(), label: name, kind: 'table' });
    for (const c of e.columns) {
      items.push({
        entityId: e.id,
        haystack: c.name.toLowerCase(),
        label: `${name}.${c.name}`,
        kind: 'column',
        column: c.name,
      });
    }
  }
  return items;
}

/** Contiguous substring match → ranges covering the hit. */
function substringRanges(hay: string, needle: string): MatchRange[] | null {
  const i = hay.indexOf(needle);
  if (i < 0) return null;
  return [{ start: i, end: i + needle.length }];
}

/** Subsequence (fuzzy) match → ranges of the matched characters, or null. */
function fuzzyRanges(hay: string, needle: string): MatchRange[] | null {
  const ranges: MatchRange[] = [];
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = -1;
    for (; hi < hay.length; hi++) {
      if (hay[hi] === ch) {
        found = hi;
        break;
      }
    }
    if (found < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last.end === found) last.end = found + 1;
    else ranges.push({ start: found, end: found + 1 });
    hi = found + 1;
  }
  return ranges;
}

/**
 * Scores a single item against a (lower-cased) query. Higher is better; null = no match.
 * Exact > prefix > word-boundary substring > substring > fuzzy; tables outrank columns.
 */
export function scoreItem(item: SearchItem, query: string): SearchHit | null {
  const hay = item.haystack;
  let score: number;
  let ranges: MatchRange[] | null;

  if (hay === query) {
    score = 1000;
    ranges = [{ start: 0, end: hay.length }];
  } else if ((ranges = substringRanges(hay, query))) {
    const at = ranges[0].start;
    const boundary = at === 0 || /[^a-z0-9]/.test(hay[at - 1]);
    score = (at === 0 ? 700 : boundary ? 560 : 420) - at;
  } else if ((ranges = fuzzyRanges(hay, query))) {
    // Prefer compact, early, fewer-gap matches.
    const span = ranges[ranges.length - 1].end - ranges[0].start;
    score = 240 - span - ranges.length * 4 - ranges[0].start;
  } else {
    return null;
  }

  if (item.kind === 'column') score -= 50;
  score -= Math.max(0, hay.length - query.length) * 0.3;
  return { item, score, ranges };
}

/**
 * Ranks all items against a query. Returns at most one hit per entity for `table` matches and keeps
 * distinct column hits. Empty / whitespace query → no hits.
 */
export function search(items: readonly SearchItem[], rawQuery: string, limit = 200): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    const hit = scoreItem(item, query);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length || (a.item.label < b.item.label ? -1 : 1));
  return hits.slice(0, limit);
}

/** Distinct, order-preserving list of entity ids that have at least one hit. */
export function matchedEntityIds(hits: readonly SearchHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (!seen.has(h.item.entityId)) {
      seen.add(h.item.entityId);
      out.push(h.item.entityId);
    }
  }
  return out;
}
