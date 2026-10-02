/**
 * Shared helpers for the Rails, Laravel, Doctrine and Ecto parsers (agent `rubyphp`).
 *
 * These ORMs are written in Ruby, PHP and Elixir and share a few mechanics: calls that may or may
 * not use parentheses (Ruby / Elixir), argument lists with named options, inline enums emitted as
 * `${table}_${attr}` and the need to add implicit columns an association creates.
 *
 * Pure TypeScript, no Node APIs.
 */

import type { Column } from '../../core/model';
import { type Args, Code, stringValue } from '../../core/text';

/** Name of an inline enum a parser emits for a column (`users` + `status` → `users_status`). */
export function inlineEnumName(table: string, attr: string): string {
  return `${table}_${attr}`;
}

/**
 * Parses the argument list of a call whose name ends at `afterName`. Handles both the
 * parenthesised form (`create table(:users, …)`) and the paren-less Ruby / Elixir form
 * (`field :email, :string, null: false`). `hardEnd` bounds a paren-less call (e.g. a block end).
 */
export function callArgs(code: Code, afterName: number, hardEnd?: number): Args {
  const m = code.masked;
  let i = afterName;
  while (i < m.length && (m[i] === ' ' || m[i] === '\t')) i++;
  if (m[i] === '(') return code.args(i);
  const limit = hardEnd ?? code.text.length;
  const end = Math.min(code.statementEnd(i), limit);
  return code.argsIn(i, end);
}

/** Splits `s` on the top-level separator, honouring (), [], {} and quotes. Trimmed, no empties. */
export function splitArgs(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let seg = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      seg += c;
      if (c === '\\' && i + 1 < s.length) seg += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      seg += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(seg.trim());
      seg = '';
      i += sep.length - 1;
      continue;
    }
    seg += c;
  }
  if (seg.trim() !== '') out.push(seg.trim());
  return out;
}

/** Values of an array / list literal: `[:a, :b]`, `["a", "b"]`, `['a', 'b']`, `{…}`. */
export function listValues(text: string): string[] {
  const t = text.trim().replace(/^[[({]/, '').replace(/[\])}]$/, '');
  const out: string[] = [];
  for (const part of splitArgs(t)) {
    const v = stringValue(part);
    if (v !== undefined) out.push(v);
    else if (/^[A-Za-z_]\w*$/.test(part)) out.push(part);
  }
  return out;
}

/** Adds `c` to `cols` unless a column with the same (case-insensitive) name already exists. */
export function addColumn(cols: Column[], c: Column): void {
  const n = c.name.toLowerCase();
  if (!cols.some((x) => x.name.toLowerCase() === n)) cols.push(c);
}
