/**
 * Shared helpers for the JVM / .NET family parsers (JPA/Hibernate, Exposed, EF Core).
 *
 * These technologies share the C-family brace syntax (`Code` with lang `java` / `kotlin` /
 * `csharp`), `@`-annotations (Java/Kotlin) and `<…>` generics (`List<Post>`, `ICollection<Tag>`).
 * Only genuinely generic utilities live here; the per-technology attribute syntax (C# `[Attr]`)
 * is handled in each parser.
 *
 * Pure, synchronous TypeScript — no Node APIs.
 */

import type { Code } from '../../core/text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Annotations (Java / Kotlin `@Name` / `@field:Name(…)`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface JvmAnnotation {
  /** Simple name without the `@` and without a package: `Column`, `ManyToOne`. */
  name: string;
  /** Full name as written: `jakarta.persistence.Column`. */
  raw: string;
  /** Kotlin use-site target (`field`, `get`, `param`, `property`…), when present. */
  target?: string;
  /** Offset of the `@`. */
  start: number;
  /** Offset of the opening `(` of the argument list, or -1 when the annotation has none. */
  open: number;
}

/** Keyword modifiers that may appear between annotations and the declarator in Java / Kotlin. */
const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'final',
  'static',
  'abstract',
  'open',
  'override',
  'sealed',
  'transient',
  'volatile',
  'synchronized',
  'native',
  'strictfp',
  'default',
  'data',
  'inner',
  'lateinit',
  'const',
  'external',
  'actual',
  'expect',
  'suspend',
  'operator',
  'infix',
  'inline',
  'value',
  'tailrec',
  'vararg',
  'crossinline',
  'noinline',
  'reified',
  'annotation',
  'companion',
  'out',
  'in',
]);

const TARGET_RE = /^(field|get|set|param|property|receiver|setparam|delegate|file|all|get:param):/;
const NAME_RE = /^[A-Za-z_][\w.]*/;
const WORD_RE = /^[A-Za-z_]\w*/;

/**
 * Reads the run of annotations and modifier keywords starting at `from` (within `[from, limit)`),
 * returning the annotations found and the offset of the first token that is neither an annotation
 * nor a modifier keyword (the declarator: a type, `class`, `val`, `fun`…).
 */
export function readAnnotations(code: Code, from: number, limit: number): { annotations: JvmAnnotation[]; declStart: number } {
  const m = code.masked;
  const annotations: JvmAnnotation[] = [];
  let i = from;
  for (;;) {
    while (i < limit && isWs(m[i])) i++;
    if (i >= limit) break;
    if (m[i] === '@') {
      const ann = readOneAnnotation(code, i, limit);
      if (!ann) break;
      annotations.push(ann);
      i = ann.open >= 0 ? skipParen(code, ann.open, limit) : ann.start + 1 + ann.raw.length + (ann.target ? ann.target.length + 1 : 0);
      continue;
    }
    const w = WORD_RE.exec(m.slice(i, Math.min(limit, i + 32)));
    if (w && MODIFIERS.has(w[0])) {
      i += w[0].length;
      continue;
    }
    break;
  }
  return { annotations, declStart: i };
}

function readOneAnnotation(code: Code, at: number, limit: number): JvmAnnotation | undefined {
  const m = code.masked;
  let p = at + 1;
  let target: string | undefined;
  const tm = TARGET_RE.exec(m.slice(p, Math.min(limit, p + 24)));
  if (tm) {
    target = tm[1];
    p += tm[0].length;
  }
  const nm = NAME_RE.exec(m.slice(p, Math.min(limit, p + 128)));
  if (!nm) return undefined;
  const raw = nm[0];
  p += raw.length;
  let open = -1;
  let q = p;
  while (q < limit && isWs(m[q])) q++;
  if (m[q] === '(') open = q;
  return { name: simpleName(raw), raw, target, start: at, open };
}

function skipParen(code: Code, open: number, limit: number): number {
  const close = code.closing(open);
  return close < 0 ? limit : close + 1;
}

/** Finds the first annotation with the given simple name (case-sensitive). */
export function findAnnotation(annotations: readonly JvmAnnotation[], name: string): JvmAnnotation | undefined {
  return annotations.find((a) => a.name === name);
}

export function hasAnnotation(annotations: readonly JvmAnnotation[], name: string): boolean {
  return annotations.some((a) => a.name === name);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Generics and types
// ─────────────────────────────────────────────────────────────────────────────────────────────

const COLLECTION_NAMES = new Set([
  'List',
  'MutableList',
  'ArrayList',
  'LinkedList',
  'Set',
  'MutableSet',
  'HashSet',
  'LinkedHashSet',
  'SortedSet',
  'TreeSet',
  'Collection',
  'MutableCollection',
  'Iterable',
  'ICollection',
  'IList',
  'IEnumerable',
  'IReadOnlyCollection',
  'IReadOnlyList',
  'ISet',
  'IReadOnlySet',
]);

/** Simple (last) name of a possibly-qualified type, with generics stripped: `java.util.List<X>` → `List`. */
export function simpleName(type: string): string {
  let t = type.trim();
  const lt = t.indexOf('<');
  if (lt >= 0) t = t.slice(0, lt);
  t = t.replace(/\?+$/, '').replace(/\[\]$/, '').trim();
  const parts = t.split(/::|\\|\.|\//).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : t;
}

/** First type argument of a generic type, split at top-level `<…>`/`(…)` depth: `Map<String, Post>` → `String`. */
export function firstTypeArg(generics: string): string | undefined {
  const parts = splitAngle(generics);
  return parts.length ? parts[0].trim() : undefined;
}

/** Inner `<…>` content of a type, or undefined when it has no generics. */
export function genericInner(type: string): string | undefined {
  const lt = type.indexOf('<');
  if (lt < 0) return undefined;
  let depth = 0;
  for (let i = lt; i < type.length; i++) {
    const c = type[i];
    if (c === '<') depth++;
    else if (c === '>' && --depth === 0) return type.slice(lt + 1, i);
  }
  return type.slice(lt + 1);
}

/** True when `type` is a generic collection (`List<X>`, `Set<X>`, `ICollection<X>`, `MutableList<X>`…). */
export function isCollectionType(type: string): boolean {
  const name = simpleName(type);
  return COLLECTION_NAMES.has(name) && /<.+>/.test(type);
}

/** Element type of a generic collection (`List<Post>` → `Post`), or undefined. Maps return the value type. */
export function collectionElement(type: string): string | undefined {
  if (!isCollectionType(type)) return undefined;
  const inner = genericInner(type);
  if (inner === undefined) return undefined;
  const args = splitAngle(inner);
  const last = args.length ? args[args.length - 1].trim() : undefined;
  return last && last.length ? last : undefined;
}

/** Splits a generic argument list on top-level commas (ignoring nested `<…>`, `(…)`, `[…]`). */
export function splitAngle(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let seg = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(seg);
      seg = '';
    } else seg += c;
  }
  if (seg.trim()) out.push(seg);
  return out;
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}
