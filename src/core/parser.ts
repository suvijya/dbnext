/**
 * Contract implemented by every schema parser, plus small helpers.
 *
 * A parser turns ONE file into a `ParseResult` (see model.ts for the exact semantics of raw
 * entities / relations / ops). Parsers must be pure, synchronous, never throw on malformed input
 * and never use Node APIs (they also run in the browser build of the extension).
 */

import type { Column, ParseResult, SourceFile, SourceKind, SourceRef } from './model';

export interface SchemaParser {
  /** Source kind this parser produces. A module may export several parsers. */
  readonly kind: SourceKind;
  /** Lower-case file extensions this parser may handle, with the dot: `['.ts', '.js']`. */
  readonly extensions: readonly string[];
  /**
   * Optional workspace-relative globs that restrict which files are searched for this parser, for
   * generic formats that would otherwise pull in every file of that type (e.g. Liquibase only wants
   * `**∕*changelog*.xml`, not every XML file). When omitted, every file with a listed extension is a
   * candidate. The extension check still applies.
   */
  readonly filePatterns?: readonly string[];
  /** Cheap pre-check on path and text (e.g. `text.includes('@Entity')`). Runs on every candidate file. */
  detect(file: SourceFile): boolean;
  /** Parses the file. Return partial results + warnings instead of throwing. */
  parse(file: SourceFile): ParseResult;
}

/** Creates a column. Defaults: nullable, not a key, not unique. */
export function column(name: string, type = '', props: Partial<Column> = {}): Column {
  return { name, type, nullable: true, primaryKey: false, unique: false, ...props };
}

export function sourceRef(file: SourceFile | string, line: number): SourceRef {
  return { file: typeof file === 'string' ? file : file.path, line };
}

/** Lower-case extension including the dot (`.ts`), `''` when there is none. `a.d.ts` → `.ts`. */
export function extOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** File name of a forward-slash path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Directory part of a forward-slash path (`''` for top-level files). */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Lower-case path segments, handy for convention checks such as `segments.includes('migrations')`. */
export function pathSegments(path: string): string[] {
  return path.toLowerCase().split('/').filter(Boolean);
}
