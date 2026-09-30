/**
 * Language-aware text scanning helpers shared by every schema parser.
 *
 * The central piece is {@link Code}. It lexes a source file once and exposes three views of the
 * text that all have *identical offsets and line breaks*:
 *
 *  - `text`     – the original text
 *  - `stripped` – comments replaced by spaces, strings intact → extract values from here
 *  - `masked`   – comments AND string contents replaced by spaces (quotes kept) → search for
 *                 structure here (regexes, bracket matching, comma splitting) without being fooled
 *                 by brackets, commas, keywords or comment markers inside strings/comments.
 *
 * Typical use:
 * ```ts
 * const code = new Code(file.text, 'python');
 * for (const m of code.masked.matchAll(/^class\s+(\w+)\s*\(/gm)) {
 *   const open = m.index! + m[0].length - 1;          // offset of '('
 *   const { positional } = code.args(open);            // spans with text from `stripped`
 *   const line = code.lineAt(m.index!);
 * }
 * ```
 * Pure TypeScript, no Node APIs: runs in the extension host (desktop + web) and in tests.
 */

export type Lang =
  | 'js'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'php'
  | 'python'
  | 'ruby'
  | 'elixir'
  | 'sql'
  | 'prisma'
  | 'dbml';

/** A trimmed slice of a {@link Code}. `text` comes from the comment-stripped view. */
export interface Span {
  start: number;
  end: number;
  text: string;
}

export interface Args {
  positional: Span[];
  /** Named / keyword arguments (`name=value`, `name: value`, `:name => value`, `'name' => value`). */
  named: Map<string, Span>;
  /** Offset just after the closing bracket (text length when unbalanced). */
  end: number;
}

export interface CodeOptions {
  /** SQL only: treat backslash as an escape character inside '…' strings (MySQL style). */
  backslashEscapes?: boolean;
}

export interface Block {
  /** Offset of the first body line (start of the line after the header). */
  start: number;
  /** Offset of the end of the last body line (its line break or the text end). */
  end: number;
  startLine: number;
  /** Last body line; equals `startLine - 1` when the body is empty. */
  endLine: number;
}

interface Region {
  start: number;
  end: number;
  comment: boolean;
  /** Content bounds: whole region for comments, delimiters excluded for strings. */
  cs: number;
  ce: number;
}

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === '') return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lexer: finds comment and string regions
// ─────────────────────────────────────────────────────────────────────────────────────────────

class Lexer {
  readonly regions: Region[] = [];
  private readonly n: number;
  private heredocs: { id: string; indent: boolean }[] = [];

  constructor(
    private readonly t: string,
    private readonly lang: Lang,
    private readonly opts: CodeOptions,
  ) {
    this.n = t.length;
  }

  run(): Region[] {
    let i = 0;
    while (i < this.n) {
      const ch = this.t[i];
      if (ch === '\n') {
        i = this.heredocs.length ? this.flushHeredocs(i + 1) : i + 1;
        continue;
      }
      const next = this.step(i, ch);
      i = next > i ? next : i + 1;
    }
    this.regions.sort((a, b) => a.start - b.start);
    return this.regions;
  }

  /** Consumes a construct starting at `i` and returns the offset after it, or `i` for plain code. */
  private step(i: number, ch: string): number {
    switch (this.lang) {
      case 'js':
        return this.cLike(i, ch, { template: true });
      case 'java':
        return this.cLike(i, ch, { triple: true });
      case 'kotlin':
        return this.cLike(i, ch, { triple: true, nested: true });
      case 'go':
        return this.cLike(i, ch, { rawBacktick: true });
      case 'csharp':
        return this.csharp(i, ch);
      case 'rust':
        return this.rust(i, ch);
      case 'php':
        return this.php(i, ch);
      case 'python':
        return this.python(i, ch);
      case 'ruby':
        return this.ruby(i, ch);
      case 'elixir':
        return this.elixir(i, ch);
      case 'sql':
        return this.sql(i, ch);
      case 'prisma':
        return this.prisma(i, ch);
      case 'dbml':
        return this.dbml(i, ch);
    }
  }

  // ── region helpers ──

  private comment(start: number, end: number): number {
    this.regions.push({ start, end, comment: true, cs: start, ce: end });
    return end;
  }

  private str(start: number, end: number, cs: number, ce: number): number {
    this.regions.push({ start, end, comment: false, cs: Math.min(cs, end), ce: Math.max(Math.min(cs, end), ce) });
    return end;
  }

  private lineComment(i: number): number {
    const e = this.t.indexOf('\n', i);
    return this.comment(i, e < 0 ? this.n : e);
  }

  private blockComment(i: number, open: string, close: string, nested: boolean): number {
    const t = this.t;
    let depth = 1;
    let j = i + open.length;
    while (j < this.n) {
      if (nested && t.startsWith(open, j)) {
        depth++;
        j += open.length;
      } else if (t.startsWith(close, j)) {
        depth--;
        j += close.length;
        if (depth === 0) return this.comment(i, j);
      } else {
        j++;
      }
    }
    return this.comment(i, this.n);
  }

  private scanQuoted(i: number, q: string, escapes: boolean, doubled: boolean, multiline: boolean) {
    const t = this.t;
    let j = i + 1;
    while (j < this.n) {
      const c = t[j];
      if (escapes && c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) {
        if (doubled && t[j + 1] === q) {
          j += 2;
          continue;
        }
        return { end: j + 1, closed: true };
      }
      if (c === '\n' && !multiline) return { end: j, closed: false };
      j++;
    }
    return { end: this.n, closed: false };
  }

  private quoted(i: number, q: string, escapes: boolean, doubled: boolean, multiline: boolean, start = i): number {
    const r = this.scanQuoted(i, q, escapes, doubled, multiline);
    return this.str(start, r.end, i + 1, r.closed ? r.end - 1 : r.end);
  }

  /** `"""…"""` / `'''…'''`. A run of more than three closing quotes ends at the end of the run. */
  private triple(i: number, q3: string, escapes: boolean, start = i): number {
    const t = this.t;
    let j = i + 3;
    while (j < this.n) {
      if (escapes && t[j] === '\\') {
        j += 2;
        continue;
      }
      if (t.startsWith(q3, j)) {
        let k = j + 3;
        while (t[k] === q3[0]) k++;
        return this.str(start, k, i + 3, k - 3);
      }
      j++;
    }
    return this.str(start, this.n, i + 3, this.n);
  }

  // ── C family (JS/TS, Java, Kotlin, Go) ──

  private cLike(
    i: number,
    ch: string,
    o: { template?: boolean; triple?: boolean; nested?: boolean; rawBacktick?: boolean },
  ): number {
    const t = this.t;
    if (ch === '/') {
      const c2 = t[i + 1];
      if (c2 === '/') return this.lineComment(i);
      if (c2 === '*') return this.blockComment(i, '/*', '*/', !!o.nested);
      return i;
    }
    if (ch === '"') {
      if (o.triple && t.startsWith('"""', i)) return this.triple(i, '"""', true);
      return this.quoted(i, '"', true, false, false);
    }
    if (ch === "'") return this.quoted(i, "'", true, false, false);
    if (ch === '`') {
      if (o.template) {
        const e = this.skipTemplate(i);
        return this.str(i, e, i + 1, e - 1 > i && t[e - 1] === '`' ? e - 1 : e);
      }
      if (o.rawBacktick) {
        const e = t.indexOf('`', i + 1);
        return e < 0 ? this.str(i, this.n, i + 1, this.n) : this.str(i, e + 1, i + 1, e);
      }
    }
    return i;
  }

  /** JS template literal starting at `i` (the backtick). Returns the offset after the closing backtick. */
  private skipTemplate(i: number): number {
    const t = this.t;
    let j = i + 1;
    while (j < this.n) {
      const c = t[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && t[j + 1] === '{') j = this.skipJsExpr(j + 2);
      else j++;
    }
    return this.n;
  }

  /** Code inside `${…}` starting after the brace. Returns the offset after the matching `}`. */
  private skipJsExpr(j: number): number {
    const t = this.t;
    let depth = 1;
    while (j < this.n) {
      const c = t[j];
      if (c === '/' && t[j + 1] === '/') {
        const e = t.indexOf('\n', j);
        j = e < 0 ? this.n : e;
      } else if (c === '/' && t[j + 1] === '*') {
        const e = t.indexOf('*/', j + 2);
        j = e < 0 ? this.n : e + 2;
      } else if (c === "'" || c === '"') {
        j = this.scanQuoted(j, c, true, false, false).end;
      } else if (c === '`') {
        j = this.skipTemplate(j);
      } else {
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return j + 1;
        j++;
      }
    }
    return this.n;
  }

  // ── C# ──

  private csharp(i: number, ch: string): number {
    const t = this.t;
    if (ch === '/') return this.cLike(i, ch, {});
    if (ch === '@' || ch === '$') {
      let j = i;
      let verbatim = false;
      while (j < i + 3 && (t[j] === '@' || t[j] === '$')) {
        if (t[j] === '@') verbatim = true;
        j++;
      }
      if (t[j] !== '"') return i;
      if (t.startsWith('"""', j)) return this.rawTriple(i, j);
      return verbatim ? this.quoted(j, '"', false, true, true, i) : this.quoted(j, '"', true, false, false, i);
    }
    if (ch === '"') return t.startsWith('"""', i) ? this.rawTriple(i, i) : this.quoted(i, '"', true, false, false);
    if (ch === "'") return this.quoted(i, "'", true, false, false);
    return i;
  }

  /** C# 11 raw string literal: N ≥ 3 quotes, closed by the same number of quotes. */
  private rawTriple(start: number, q: number): number {
    const t = this.t;
    let k = q;
    while (t[k] === '"') k++;
    const closer = '"'.repeat(k - q);
    const e = t.indexOf(closer, k);
    return e < 0 ? this.str(start, this.n, k, this.n) : this.str(start, e + closer.length, k, e);
  }

  // ── Rust ──

  private rust(i: number, ch: string): number {
    const t = this.t;
    if (ch === '/') return this.cLike(i, ch, { nested: true });
    if ((ch === 'r' || ch === 'b') && !isIdentChar(t[i - 1])) {
      let j = i + 1;
      if (ch === 'b' && t[j] === 'r') j++;
      if (ch === 'r' || j > i + 1) {
        let h = 0;
        while (t[j + h] === '#') h++;
        if (t[j + h] === '"') {
          const closer = '"' + '#'.repeat(h);
          const cs = j + h + 1;
          const e = t.indexOf(closer, cs);
          return e < 0 ? this.str(i, this.n, cs, this.n) : this.str(i, e + closer.length, cs, e);
        }
      }
      return i;
    }
    if (ch === '"') return this.quoted(i, '"', true, false, true);
    if (ch === "'") {
      // Char literal ('a', '\n', '\u{1F600}') vs. lifetime ('a, 'static).
      if (t[i + 1] === '\\') {
        const e = t.indexOf("'", i + 3);
        return e > 0 && e - i <= 12 ? this.str(i, e + 1, i + 1, e) : i;
      }
      if (t[i + 2] === "'" && t[i + 1] !== '\n') return this.str(i, i + 3, i + 1, i + 2);
      const cp = t.codePointAt(i + 1);
      if (cp !== undefined && cp > 0xffff && t[i + 3] === "'") return this.str(i, i + 4, i + 1, i + 3);
      return i;
    }
    return i;
  }

  // ── PHP ──

  private php(i: number, ch: string): number {
    const t = this.t;
    if (ch === '/') return this.cLike(i, ch, {});
    if (ch === '#') return t[i + 1] === '[' ? i : this.lineComment(i); // `#[Attr]` is PHP 8 syntax
    if (ch === "'" || ch === '"') return this.quoted(i, ch, true, false, true);
    if (ch === '<' && t.startsWith('<<<', i)) return this.phpHeredoc(i);
    return i;
  }

  private phpHeredoc(i: number): number {
    const t = this.t;
    const m = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1[ \t]*\r?\n/.exec(t.slice(i, i + 200));
    if (!m) return i;
    const id = m[2];
    const bodyStart = i + m[0].length;
    let ls = bodyStart;
    while (ls < this.n) {
      let le = t.indexOf('\n', ls);
      if (le < 0) le = this.n;
      const idm = /^[ \t]*([A-Za-z_]\w*)/.exec(t.slice(ls, le));
      if (idm && idm[1] === id) return this.str(i, ls + idm[0].length, bodyStart, ls);
      ls = le + 1;
    }
    return this.str(i, this.n, bodyStart, this.n);
  }

  // ── Python ──

  private python(i: number, ch: string): number {
    if (ch === '#') return this.lineComment(i);
    if (ch === '"' || ch === "'") {
      const q3 = ch + ch + ch;
      return this.t.startsWith(q3, i) ? this.triple(i, q3, true) : this.quoted(i, ch, true, false, false);
    }
    return i;
  }

  // ── Ruby ──

  private ruby(i: number, ch: string): number {
    const t = this.t;
    if (ch === '#') return this.lineComment(i);
    if (ch === '=' && (i === 0 || t[i - 1] === '\n') && t.startsWith('=begin', i)) {
      const e = t.indexOf('\n=end', i);
      if (e < 0) return this.comment(i, this.n);
      const le = t.indexOf('\n', e + 1);
      return this.comment(i, le < 0 ? this.n : le);
    }
    if (ch === "'") return this.quoted(i, "'", true, false, true);
    if (ch === '"') return this.interpString(i, '"');
    if (ch === '<' && t[i + 1] === '<') return this.rubyHeredocToken(i);
    if (ch === '%') return this.rubyPercent(i);
    return i;
  }

  /** Double-quoted string with `#{…}` interpolation (Ruby, Elixir). */
  private interpString(i: number, q: string): number {
    const t = this.t;
    let j = i + 1;
    while (j < this.n) {
      const c = t[j];
      if (c === '\\') j += 2;
      else if (c === q) return this.str(i, j + 1, i + 1, j);
      else if (c === '#' && t[j + 1] === '{') j = this.skipInterp(j + 2);
      else j++;
    }
    return this.str(i, this.n, i + 1, this.n);
  }

  private skipInterp(j: number): number {
    const t = this.t;
    let depth = 1;
    while (j < this.n) {
      const c = t[j];
      if (c === '\\') j += 2;
      else if (c === '"' || c === "'") j = this.scanQuoted(j, c, true, false, true).end;
      else {
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return j + 1;
        j++;
      }
    }
    return this.n;
  }

  private rubyHeredocToken(i: number): number {
    const m = /^<<([~-]?)(?:(["'`])([^"'`\n]+)\2|([A-Za-z_]\w*))/.exec(this.t.slice(i, i + 100));
    if (!m) return i;
    const flag = m[1];
    const quoted = !!m[2];
    const id = m[3] ?? m[4];
    // `list <<item` (append) vs `<<SQL` (heredoc): bare identifiers must look like constants.
    if (!flag && !quoted && !/^[A-Z_]/.test(id)) return i;
    this.heredocs.push({ id, indent: flag !== '' });
    return i + m[0].length;
  }

  /** Called at the start of the line following heredoc tokens; consumes their bodies. */
  private flushHeredocs(pos: number): number {
    const t = this.t;
    let ls = pos;
    let last = pos - 1;
    for (const h of this.heredocs) {
      const bodyStart = ls;
      let found = -1;
      let foundEnd = this.n;
      while (ls < this.n) {
        let le = t.indexOf('\n', ls);
        if (le < 0) le = this.n;
        let line = t.slice(ls, le);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if ((h.indent ? line.trim() : line) === h.id) {
          found = ls;
          foundEnd = le;
          break;
        }
        ls = le + 1;
      }
      if (found < 0) {
        this.str(bodyStart, this.n, bodyStart, this.n);
        this.heredocs = [];
        return this.n;
      }
      this.str(bodyStart, foundEnd, bodyStart, found);
      last = foundEnd;
      ls = foundEnd + 1;
    }
    this.heredocs = [];
    return Math.max(last, pos);
  }

  /** `%w[a b]`, `%i(a b)`, `%q{…}`, `%(…)` literals. */
  private rubyPercent(i: number): number {
    const t = this.t;
    const m = /^%([qQwWiIsr]?)([(\[{<|!/])/.exec(t.slice(i, i + 3));
    if (!m) return i;
    if (i > 0 && !/[\s(,=[{:>]/.test(t[i - 1])) return i; // modulo operator
    const open = m[2];
    const close = CLOSERS[open] ?? open;
    const cs = i + m[0].length;
    let depth = 1;
    let j = cs;
    while (j < this.n) {
      const c = t[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (open !== close && c === open) depth++;
      else if (c === close && --depth === 0) return this.str(i, j + 1, cs, j);
      j++;
    }
    return this.str(i, this.n, cs, this.n);
  }

  // ── Elixir ──

  private elixir(i: number, ch: string): number {
    const t = this.t;
    if (ch === '#') return this.lineComment(i);
    if (ch === '"' || ch === "'") {
      const q3 = ch + ch + ch;
      if (t.startsWith(q3, i)) return this.triple(i, q3, true);
      return ch === '"' ? this.interpString(i, '"') : this.quoted(i, "'", true, false, true);
    }
    if (ch === '~' && /[a-zA-Z]/.test(t[i + 1] ?? '')) return this.elixirSigil(i);
    return i;
  }

  private elixirSigil(i: number): number {
    const t = this.t;
    let j = i + 1;
    while (/[a-zA-Z]/.test(t[j] ?? '')) j++;
    const d = t[j];
    if (d === undefined) return i;
    if ((d === '"' || d === "'") && t.startsWith(d + d + d, j)) return this.triple(j, d + d + d, true, i);
    const close = CLOSERS[d] ?? (/[|/"']/.test(d) ? d : undefined);
    if (!close) return i;
    let k = j + 1;
    while (k < this.n) {
      const c = t[k];
      if (c === '\\') k += 2;
      else if (c === close) return this.str(i, k + 1, j + 1, k);
      else k++;
    }
    return this.str(i, this.n, j + 1, this.n);
  }

  // ── SQL ──

  private sql(i: number, ch: string): number {
    const t = this.t;
    if (ch === '-' && t[i + 1] === '-') return this.lineComment(i);
    if (ch === '/' && t[i + 1] === '*') return this.blockComment(i, '/*', '*/', false);
    if (ch === "'") {
      const prev = t[i - 1];
      const eString = (prev === 'E' || prev === 'e') && !isIdentChar(t[i - 2]);
      return this.quoted(i, "'", eString || !!this.opts.backslashEscapes, true, true);
    }
    if (ch === '"' || ch === '`') return this.quoted(i, ch, false, true, true);
    if (ch === '$' && !isIdentChar(t[i - 1])) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(t.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = t.indexOf(tag, i + tag.length);
        return e < 0 ? this.str(i, this.n, i + tag.length, this.n) : this.str(i, e + tag.length, i + tag.length, e);
      }
    }
    return i;
  }

  // ── Prisma / DBML ──

  private prisma(i: number, ch: string): number {
    if (ch === '/' && this.t[i + 1] === '/') return this.lineComment(i);
    if (ch === '"') return this.quoted(i, '"', true, false, false);
    return i;
  }

  private dbml(i: number, ch: string): number {
    const t = this.t;
    if (ch === '/') return this.cLike(i, ch, {});
    if (ch === "'" && t.startsWith("'''", i)) return this.triple(i, "'''", true);
    if (ch === "'" || ch === '"') return this.quoted(i, ch, true, false, false);
    if (ch === '`') return this.quoted(i, '`', false, false, false);
    return i;
  }
}

function blank(text: string, regions: readonly Region[], strings: boolean): string {
  const parts: string[] = [];
  let pos = 0;
  for (const r of regions) {
    const s = r.comment ? r.start : strings ? r.cs : -1;
    const e = r.comment ? r.end : strings ? r.ce : -1;
    if (s < pos || e <= s) continue;
    parts.push(text.slice(pos, s), text.slice(s, e).replace(/[^\r\n]/g, ' '));
    pos = e;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Line index
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Maps offsets to 0-based line numbers and back. */
export class LineIndex {
  private readonly starts: number[];

  constructor(private readonly text: string) {
    const s = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
    this.starts = s;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  lineAt(offset: number): number {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))];
  }

  /** Offset of the line's `\n` (or the text length for the last line). */
  lineEnd(line: number): number {
    return line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
  }
}

/** 0-based line number of `offset` in `text` (convenience for one-off lookups). */
export function lineOf(text: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Code
// ─────────────────────────────────────────────────────────────────────────────────────────────

type NamedStyle = { eq: boolean; colon: boolean; rocket: boolean };

const NAMED_STYLES: Readonly<Record<Lang, NamedStyle>> = {
  js: { eq: false, colon: false, rocket: false },
  go: { eq: false, colon: false, rocket: false },
  rust: { eq: false, colon: false, rocket: false },
  sql: { eq: false, colon: false, rocket: false },
  python: { eq: true, colon: false, rocket: false },
  java: { eq: true, colon: false, rocket: false },
  kotlin: { eq: true, colon: false, rocket: false },
  csharp: { eq: true, colon: true, rocket: false },
  ruby: { eq: false, colon: true, rocket: true },
  php: { eq: false, colon: true, rocket: true },
  elixir: { eq: false, colon: true, rocket: true },
  prisma: { eq: false, colon: true, rocket: false },
  dbml: { eq: false, colon: true, rocket: false },
};

const NAMED_EQ = /^([A-Za-z_]\w*)\s*=(?![=>~])\s*/;
const NAMED_COLON = /^(?:([A-Za-z_]\w*[?!]?)|"([^"\n]*)"|'([^'\n]*)')\s*:(?!:)\s*/;
const NAMED_ROCKET = /^(?::([A-Za-z_]\w*[?!]?)|"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_]\w*))\s*=>\s*/;
const OBJECT_KEY = /^(?:([A-Za-z_$][\w$]*)|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|(\d+))\s*:(?!:)\s*/;

export class Code {
  readonly text: string;
  readonly lang: Lang;
  private readonly regions: Region[];
  private _stripped?: string;
  private _masked?: string;
  private _lines?: LineIndex;

  constructor(text: string, lang: Lang, options: CodeOptions = {}) {
    this.text = text;
    this.lang = lang;
    this.regions = new Lexer(text, lang, options).run();
  }

  /** Comments replaced by spaces; strings intact. Same length and line breaks as `text`. */
  get stripped(): string {
    return (this._stripped ??= blank(this.text, this.regions, false));
  }

  /** Comments and string *contents* replaced by spaces; quotes kept. Same length as `text`. */
  get masked(): string {
    return (this._masked ??= blank(this.text, this.regions, true));
  }

  get lines(): LineIndex {
    return (this._lines ??= new LineIndex(this.text));
  }

  get lineCount(): number {
    return this.lines.lineCount;
  }

  lineAt(offset: number): number {
    return this.lines.lineAt(offset);
  }

  lineStart(line: number): number {
    return this.lines.lineStart(line);
  }

  lineEnd(line: number): number {
    return this.lines.lineEnd(line);
  }

  /** A line of the stripped view, without its line break. */
  line(line: number): string {
    return this.stripped.slice(this.lineStart(line), this.lineEnd(line)).replace(/\r$/, '');
  }

  /** Width of the leading whitespace of a line (tab = 4). */
  indentOf(line: number): number {
    const m = this.masked;
    let w = 0;
    for (let i = this.lineStart(line); i < m.length; i++) {
      const c = m[i];
      if (c === ' ') w++;
      else if (c === '\t') w += 4;
      else break;
    }
    return w;
  }

  /** Outside comments and string contents (string delimiters count as code)? */
  isCode(offset: number): boolean {
    const r = this.regionAt(offset);
    return !r || (!r.comment && (offset < r.cs || offset >= r.ce));
  }

  /** Inside a string literal (delimiters included). */
  inString(offset: number): boolean {
    const r = this.regionAt(offset);
    return !!r && !r.comment;
  }

  inComment(offset: number): boolean {
    const r = this.regionAt(offset);
    return !!r && r.comment;
  }

  /** Trimmed span of the stripped text between two offsets. */
  span(start: number, end: number): Span {
    const m = this.masked;
    let s = Math.max(0, start);
    let e = Math.min(m.length, end);
    while (s < e && isSpace(m[s])) s++;
    while (e > s && isSpace(m[e - 1])) e--;
    return { start: s, end: e, text: this.stripped.slice(s, e) };
  }

  /** Stripped text between two offsets (not trimmed). */
  slice(start: number, end: number): string {
    return this.stripped.slice(start, end);
  }

  /**
   * Offset of the bracket matching the one at `open` (`(`, `[`, `{` or `<`), ignoring strings and
   * comments, or -1. Only brackets of the same kind are counted. For `<`, `=>`/`->` arrows are ignored.
   */
  closing(open: number): number {
    const m = this.masked;
    const o = m[open];
    const c = CLOSERS[o];
    if (!c) return -1;
    let depth = 0;
    for (let i = open; i < m.length; i++) {
      const ch = m[i];
      if (ch === o) depth++;
      else if (ch === c) {
        if (o === '<' && (m[i - 1] === '=' || m[i - 1] === '-')) continue;
        if (--depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Splits `[start, end)` on `sep` at bracket depth 0, outside strings and comments.
   * Returns trimmed, non-empty spans. With `angle`, `<…>` also counts as brackets (generic types).
   */
  split(start: number, end: number, sep = ',', options: { angle?: boolean } = {}): Span[] {
    const m = this.masked;
    const out: Span[] = [];
    const angle = !!options.angle;
    let depth = 0;
    let seg = start;
    const push = (s: number, e: number) => {
      const sp = this.span(s, e);
      if (sp.end > sp.start) out.push(sp);
    };
    for (let i = start; i < end; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{' || (angle && ch === '<')) depth++;
      else if (ch === ')' || ch === ']' || ch === '}' || (angle && ch === '>' && m[i - 1] !== '=' && m[i - 1] !== '-')) {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && m.startsWith(sep, i)) {
        push(seg, i);
        seg = i + sep.length;
        i += sep.length - 1;
      }
    }
    push(seg, end);
    return out;
  }

  /** Items inside the bracket pair opening at `open`, split on `sep`. */
  items(open: number, sep = ','): Span[] {
    const close = this.closing(open);
    return this.split(open + 1, close < 0 ? this.text.length : close, sep);
  }

  /** Inner range of the bracket pair opening at `open` (`end` is the closing bracket offset). */
  inner(open: number): { start: number; end: number } | undefined {
    const close = this.closing(open);
    return close < 0 ? undefined : { start: open + 1, end: close };
  }

  /**
   * Parses a call / attribute / annotation argument list. `open` is the offset of `(`, `[` or `{`.
   * Named-argument syntax depends on the language: `name=value` (Python, Java, Kotlin, C#),
   * `name: value` (Ruby, PHP, Elixir, C#, Prisma, DBML), `:name => value` / `'name' => value`
   * (Ruby, PHP, Elixir).
   */
  args(open: number): Args {
    const close = this.closing(open);
    const end = close < 0 ? this.text.length : close;
    return { ...this.argsIn(open + 1, end), end: close < 0 ? this.text.length : close + 1 };
  }

  /**
   * Like {@link args} but for an arbitrary range, e.g. a paren-less Ruby / Elixir call:
   * `code.argsIn(start, code.statementEnd(start))`. `end` of the result is the range end.
   */
  argsIn(start: number, end: number): Args {
    const style = NAMED_STYLES[this.lang];
    const positional: Span[] = [];
    const named = new Map<string, Span>();
    for (const part of this.split(start, end, ',')) {
      const kw = this.matchNamed(part, style);
      if (kw) named.set(kw.key, this.span(part.start + kw.skip, part.end));
      else positional.push(part);
    }
    return { positional, named, end };
  }

  /**
   * End offset of a line-oriented statement starting at `offset` (Ruby, Python, Elixir): the end of
   * the line, extended while brackets are open or the line ends with `,` or `\`. Stops before a
   * closing bracket that belongs to an enclosing construct.
   */
  statementEnd(offset: number): number {
    const m = this.masked;
    let depth = 0;
    let i = offset;
    for (; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) return i;
        depth--;
      } else if (ch === '\n' && depth === 0) {
        let p = i - 1;
        while (p >= offset && (m[p] === ' ' || m[p] === '\t' || m[p] === '\r')) p--;
        if (p >= offset && (m[p] === ',' || m[p] === '\\')) continue;
        return m[i - 1] === '\r' ? i - 1 : i;
      }
    }
    return i;
  }

  private matchNamed(part: Span, style: NamedStyle): { key: string; skip: number } | undefined {
    const t = part.text;
    let m: RegExpExecArray | null;
    if (style.rocket && (m = NAMED_ROCKET.exec(t))) return { key: m[1] ?? m[2] ?? m[3] ?? m[4], skip: m[0].length };
    if (style.colon && (m = NAMED_COLON.exec(t))) return { key: m[1] ?? m[2] ?? m[3], skip: m[0].length };
    if (style.eq && (m = NAMED_EQ.exec(t))) return { key: m[1], skip: m[0].length };
    return undefined;
  }

  /**
   * Parses an object / dict literal whose `{` is at `open`: `key: value`, `"key": value`, `'key': value`,
   * shorthand `key`. Spreads, computed keys and methods are skipped.
   */
  object(open: number): Map<string, Span> {
    const out = new Map<string, Span>();
    for (const part of this.items(open)) {
      const m = OBJECT_KEY.exec(part.text);
      if (m) {
        out.set(m[1] ?? m[2] ?? m[3] ?? m[4], this.span(part.start + m[0].length, part.end));
      } else if (/^[A-Za-z_$][\w$]*$/.test(part.text)) {
        out.set(part.text, part);
      }
    }
    return out;
  }

  /**
   * Indentation-based block (Python classes, Ruby/Elixir `do … end` with formatted code): the lines
   * after `headerEndLine` that are indented deeper than `headerLine`. Blank lines, comment-only lines
   * and continuation lines of multi-line strings are ignored. The closing `end` of Ruby/Elixir blocks
   * is not included because it has the header's indentation.
   */
  indentedBlock(headerLine: number, headerEndLine = headerLine): Block {
    const base = this.indentOf(headerLine);
    const startLine = headerEndLine + 1;
    let last = headerEndLine;
    for (let l = startLine; l < this.lineCount; l++) {
      if (this.isBlankForIndent(l)) continue;
      if (this.indentOf(l) <= base) break;
      last = l;
    }
    const start = startLine < this.lineCount ? this.lineStart(startLine) : this.text.length;
    return { start, end: last >= startLine ? this.lineEnd(last) : start, startLine, endLine: last };
  }

  private isBlankForIndent(line: number): boolean {
    const m = this.masked;
    const ls = this.lineStart(line);
    const le = this.lineEnd(line);
    let i = ls;
    while (i < le && isSpace(m[i])) i++;
    if (i >= le) return true;
    const r = this.regionAt(i);
    return !!r && !r.comment && r.start < ls; // continuation of a multi-line string
  }

  /**
   * Raw text of the comments directly above the line containing `offset` (doc comments), top to bottom.
   * Stops at code, at a blank line, or at a comment that shares its line with code.
   */
  leadingComments(offset: number): string[] {
    const t = this.text;
    const out: string[] = [];
    let pos = this.lineStart(this.lineAt(offset));
    for (;;) {
      let p = pos - 1;
      let newlines = 0;
      while (p >= 0 && isSpace(t[p])) {
        if (t[p] === '\n') newlines++;
        p--;
      }
      if (p < 0 || newlines > 1) break;
      const r = this.regionAt(p);
      if (!r || !r.comment) break;
      const ls = this.lineStart(this.lineAt(r.start));
      if (t.slice(ls, r.start).trim() !== '') break;
      out.unshift(t.slice(r.start, r.end));
      pos = r.start;
    }
    return out;
  }

  private regionAt(offset: number): Region | undefined {
    const rs = this.regions;
    let lo = 0;
    let hi = rs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].start <= offset) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return undefined;
    const r = rs[found];
    return offset < r.end ? r : undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Literal helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '0': '\0' };

/**
 * Value of a string-ish literal expression, or `undefined` when `expr` is not a single literal:
 * `"x"`, `'x'`, `` `x` `` (without `${}`), `"""x"""`, Python prefixes (`r"x"`, `f"x"`…),
 * C# `@"x"`, SQL `N'x'` / `E'x'`, Ruby/Elixir symbols `:x` / `:"x"`.
 */
export function stringValue(expr: string | undefined): string | undefined {
  if (expr === undefined) return undefined;
  const s = expr.trim();
  let m = /^:([A-Za-z_]\w*[?!]?)$/.exec(s);
  if (m) return m[1];
  let raw = false;
  let doubled = false;
  let body = s;
  if (body.startsWith(':"')) body = body.slice(1);
  m = /^([rRbBuUfF]{1,2}|[@$]{1,2}|[NnEe])(?=["'`])/.exec(body);
  if (m) {
    const p = m[1];
    raw = /[rR]/.test(p) && !/[@$]/.test(p);
    doubled = p.includes('@');
    body = body.slice(p.length);
  }
  for (const q3 of ['"""', "'''"]) {
    if (body.length >= 6 && body.startsWith(q3) && body.endsWith(q3)) return body.slice(3, -3);
  }
  const q = body[0];
  if ((q !== '"' && q !== "'" && q !== '`') || body.length < 2 || body[body.length - 1] !== q) return undefined;
  const content = body.slice(1, -1);
  if (q === '`' && content.includes('${')) return undefined;
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '\\' && !raw && !doubled && i + 1 < content.length) {
      const n = content[++i];
      out += ESCAPES[n] ?? n;
    } else if (c === q) {
      if (content[i + 1] !== q) return undefined; // e.g. "a" + "b"
      out += q;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** `true` / `false` literal in any common casing, otherwise `undefined`. */
export function boolValue(expr: string | undefined): boolean | undefined {
  const s = expr?.trim();
  if (s === undefined) return undefined;
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  return undefined;
}

/** Numeric literal value (`42`, `-1.5`, `1_000`), otherwise `undefined`. */
export function numberValue(expr: string | undefined): number | undefined {
  const s = expr?.trim().replace(/_/g, '');
  if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** Removes identifier quoting: `"x"`, `` `x` ``, `[x]`, `'x'` → `x` (doubled quotes unescaped). */
export function unquoteIdent(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' || a === '`' || a === "'") && b === a) return t.slice(1, -1).split(a + a).join(a);
    if (a === '[' && b === ']') return t.slice(1, -1).replace(/]]/g, ']');
  }
  return t;
}

/** Splits a qualified identifier on dots outside quotes and unquotes the parts: `"a"."b.c"` → `['a', 'b.c']`. */
export function splitQualified(name: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let close: string | null = null;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (close) {
      cur += c;
      if (c === close) {
        if (name[i + 1] === close) cur += name[++i];
        else close = null;
      }
    } else if (c === '"' || c === '`' || c === '[') {
      close = c === '[' ? ']' : c;
      cur += c;
    } else if (c === '.') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => unquoteIdent(p)).filter((p) => p !== '');
}

/** Removes comment markers (`//`, `///`, `/** … *\/`, leading `*`, `#`, `--`) from raw comment text. */
export function cleanComment(raw: string): string {
  return raw
    .replace(/^\s*\/\*+/, '')
    .replace(/\*+\/\s*$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\/\/+|#+|--+|\*(?!\/))\s?/, '').trimEnd())
    .join('\n')
    .trim();
}
