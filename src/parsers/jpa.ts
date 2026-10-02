/**
 * JPA / Hibernate parser (Java and Kotlin), with best-effort Spring Data JDBC support.
 *
 * Reads `@Entity` / `@MappedSuperclass` / `@Embeddable` classes and their fields / Kotlin
 * properties, applying the Spring Boot default naming convention (snake_case) unless `@Table` /
 * `@Column` configure a name. Produces one `RawEntity` per persistent class, `RawRelation`s for the
 * association annotations (`@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`) and `RawEnum`s
 * for enum types used by `@Enumerated` columns.
 *
 * Pure, synchronous TypeScript — no Node APIs. Never throws: returns partial results + warnings.
 */

import type { Column, ParseResult, RawEntity, RawEnum, RawRelation, SourceFile } from '../core/model';
import { column, extOf, sourceRef, type SchemaParser } from '../core/parser';
import { defaultTableName, lcfirst, snakeCase } from '../core/naming';
import { Code, boolValue, numberValue, stringValue, unquoteIdent, type Lang } from '../core/text';
import {
  collectionElement,
  findAnnotation,
  hasAnnotation,
  readAnnotations,
  simpleName,
  splitAngle,
  type JvmAnnotation,
} from './shared/jvmnet';

const PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double']);
const TYPE_KEYWORDS = new Set(['class', 'interface', 'record', 'object', 'enum']);
const NEW_DECL = new Set(['class', 'interface', 'record', 'object', 'enum', 'fun', 'val', 'var', 'companion', 'init', 'constructor']);

const WORD_RE = /^[A-Za-z_]\w*/;

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Type discovery
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface TypeDecl {
  name: string;
  keyword: string;
  isEnum: boolean;
  annotations: JvmAnnotation[];
  bodyOpen: number;
  bodyClose: number;
  headerEnd: number;
  afterName: number;
  ctorOpen: number;
  extendsNames: string[];
  declStart: number;
}

/** Finds every type declaration (class / interface / enum / object / record) at any nesting. */
function discoverTypes(code: Code, lang: Lang): TypeDecl[] {
  const out: TypeDecl[] = [];
  walkTypes(code, 0, code.masked.length, lang, out);
  return out;
}

function walkTypes(code: Code, start: number, end: number, lang: Lang, out: TypeDecl[]): void {
  const m = code.masked;
  let pos = start;
  let pending: JvmAnnotation[] = [];
  let pendingStart = -1;
  let enumFlag = false;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const c = m[pos];
    if (c === '@') {
      const ann = readAnnotations(code, pos, end);
      if (ann.annotations.length) {
        if (pendingStart < 0) pendingStart = pos;
        pending.push(...ann.annotations);
      }
      pos = ann.declStart > pos ? ann.declStart : pos + 1;
      continue;
    }
    const w = WORD_RE.exec(m.slice(pos, pos + 40));
    if (!w) {
      if (c === '{' || c === '(' || c === '[') {
        const cl = code.closing(pos);
        pos = cl < 0 ? end : cl + 1;
      } else pos++;
      pending = [];
      pendingStart = -1;
      enumFlag = false;
      continue;
    }
    const word = w[0];
    if (TYPE_KEYWORDS.has(word)) {
      if (word === 'enum' && lang === 'kotlin') {
        // Kotlin `enum class` – `enum` is a modifier, the real keyword is `class`.
        enumFlag = true;
        pos += word.length;
        continue;
      }
      const decl = parseTypeHeader(code, pos, word, end, lang, pending, pendingStart, enumFlag || word === 'enum');
      out.push(decl);
      if (decl.bodyOpen >= 0 && decl.bodyClose > decl.bodyOpen) walkTypes(code, decl.bodyOpen + 1, decl.bodyClose, lang, out);
      pos = decl.bodyOpen >= 0 && decl.bodyClose >= 0 ? decl.bodyClose + 1 : decl.headerEnd;
      pending = [];
      pendingStart = -1;
      enumFlag = false;
      continue;
    }
    // Modifier keywords keep the pending annotations; anything else clears them.
    pos += word.length;
    if (!MODIFIER_WORDS.has(word)) {
      pending = [];
      pendingStart = -1;
      enumFlag = false;
    }
  }
}

const MODIFIER_WORDS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'final',
  'static',
  'abstract',
  'open',
  'sealed',
  'data',
  'inner',
  'value',
  'annotation',
  'companion',
]);

function parseTypeHeader(
  code: Code,
  kwPos: number,
  keyword: string,
  limit: number,
  lang: Lang,
  annotations: JvmAnnotation[],
  pendingStart: number,
  isEnum: boolean,
): TypeDecl {
  const m = code.masked;
  const after = kwPos + keyword.length;
  const nm = /^\s+([A-Za-z_]\w*)/.exec(m.slice(after, after + 100));
  const name = nm ? nm[1] : '';
  const afterName = nm ? after + nm[0].length : after;
  const body = lang === 'kotlin' ? kotlinClassBody(code, afterName, limit) : classBody(code, afterName, limit);
  const bodyOpen = body.bodyOpen;
  const bodyClose = bodyOpen >= 0 ? code.closing(bodyOpen) : -1;
  const headerEnd = bodyOpen >= 0 ? bodyOpen : body.stop;
  const colon = lang === 'kotlin' ? findTop(code, afterName, headerEnd, ':') : -1;
  const supertypeStart = lang === 'kotlin' ? (colon >= 0 ? colon + 1 : headerEnd) : afterName;
  const ctorEnd = lang === 'kotlin' ? (colon >= 0 ? colon : headerEnd) : keyword === 'record' ? headerEnd : afterName;
  const ctorOpen = findTop(code, afterName, ctorEnd, '(');
  const extendsNames = parseExtends(code, afterName, headerEnd, supertypeStart, lang);
  return {
    name,
    keyword,
    isEnum,
    annotations,
    bodyOpen,
    bodyClose,
    headerEnd,
    afterName,
    ctorOpen,
    extendsNames,
    declStart: annotations.length && pendingStart >= 0 ? pendingStart : kwPos,
  };
}

/** First `{` of a class body, scanning past `(…)`/`[…]`; stops at a stray `}`/`;` or a sibling decl. */
function classBody(code: Code, from: number, limit: number): { bodyOpen: number; stop: number } {
  const m = code.masked;
  let paren = 0;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[') {
      const cl = code.closing(i);
      i = cl < 0 ? limit : cl;
      continue;
    }
    if (c === '{') return { bodyOpen: i, stop: i };
    if (paren === 0 && (c === '}' || c === ';')) return { bodyOpen: -1, stop: i };
    if (paren === 0 && /[A-Za-z_]/.test(c) && !/[\w$]/.test(m[i - 1] ?? '')) {
      const w = WORD_RE.exec(m.slice(i, i + 16));
      if (w && NEW_DECL.has(w[0])) return { bodyOpen: -1, stop: i };
    }
  }
  return { bodyOpen: -1, stop: limit };
}

/** Kotlin class body detection: handles brace-less classes (`data class User(val id: Long)`). */
const CONT_PREV = new Set([',', '(', '[', ':', '.', '+', '-', '*', '/', '?', '&', '|', '=', '<', '>']);

function kotlinClassBody(code: Code, from: number, limit: number): { bodyOpen: number; stop: number } {
  const m = code.masked;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[') {
      const cl = code.closing(i);
      i = cl < 0 ? limit : cl;
      continue;
    }
    if (c === '{') return { bodyOpen: i, stop: i };
    if (c === '}' || c === ';') return { bodyOpen: -1, stop: i };
    if (/[A-Za-z_]/.test(c) && !/[\w$]/.test(m[i - 1] ?? '')) {
      const w = WORD_RE.exec(m.slice(i, i + 16));
      if (w && NEW_DECL.has(w[0])) return { bodyOpen: -1, stop: i };
    }
    if (c === '\n') {
      let p = i - 1;
      while (p >= from && (m[p] === ' ' || m[p] === '\t' || m[p] === '\r')) p--;
      if (p >= from && CONT_PREV.has(m[p])) continue;
      let q = i + 1;
      while (q < limit && isWs(m[q])) q++;
      const next = m[q];
      if (next === '{' || next === '.' || next === ':' || next === ',' || next === ')') continue;
      return { bodyOpen: -1, stop: i };
    }
  }
  return { bodyOpen: -1, stop: limit };
}
function findTop(code: Code, from: number, to: number, ch: string): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (depth === 0 && c === ch) return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return -1;
}

function parseExtends(code: Code, afterName: number, headerEnd: number, supertypeStart: number, lang: Lang): string[] {
  if (lang === 'kotlin') {
    if (supertypeStart >= headerEnd) return [];
    const text = stripAngles(code.slice(supertypeStart, headerEnd));
    return splitAngle(text)
      .map((s) => simpleName(s.replace(/\(.*$/s, '').trim()))
      .filter(Boolean);
  }
  const text = stripAngles(code.slice(afterName, headerEnd));
  const out: string[] = [];
  const ext = /\bextends\s+([A-Za-z_][\w.]*)/.exec(text);
  if (ext) out.push(simpleName(ext[1]));
  return out;
}

/** Removes balanced `<…>` from a header string so `extends` bounds / supertypes parse cleanly. */
function stripAngles(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field / property extraction
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FieldInfo {
  name: string;
  type: string;
  annotations: JvmAnnotation[];
  modifiers: string;
  initializer?: string;
  memberStart: number;
}

function collectFields(code: Code, decl: TypeDecl, lang: Lang): FieldInfo[] {
  if (lang === 'kotlin') {
    const out: FieldInfo[] = [];
    if (decl.ctorOpen >= 0) out.push(...kotlinCtorProps(code, decl.ctorOpen));
    if (decl.bodyOpen >= 0 && decl.bodyClose > decl.bodyOpen) out.push(...kotlinBodyProps(code, decl.bodyOpen + 1, decl.bodyClose));
    return out;
  }
  const out: FieldInfo[] = [];
  // Record components (`record Account(@Id Long id, String owner)`) are persistent fields too.
  if (decl.keyword === 'record' && decl.ctorOpen >= 0) out.push(...javaRecordComponents(code, decl.ctorOpen));
  if (decl.bodyOpen >= 0 && decl.bodyClose > decl.bodyOpen) {
    const { fields, getters } = javaMembers(code, decl.bodyOpen + 1, decl.bodyClose);
    // Property access: JPA mapping annotations sit on getters (access type PROPERTY). Detected by an
    // @Id / @EmbeddedId on a getter with no field carrying one. Then the getters are the fields.
    const propertyAccess =
      getters.some((g) => hasAnnotation(g.annotations, 'Id') || hasAnnotation(g.annotations, 'EmbeddedId')) &&
      !fields.some((f) => hasAnnotation(f.annotations, 'Id') || hasAnnotation(f.annotations, 'EmbeddedId'));
    out.push(...(propertyAccess ? getters : fields));
  }
  return out;
}

/** Record components of a Java record, parsed from its component list `(…)`. */
function javaRecordComponents(code: Code, open: number): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const item of code.split(open + 1, code.closing(open) < 0 ? open + 1 : code.closing(open), ',')) {
    const { annotations, declStart } = readAnnotations(code, item.start, item.end);
    const decl = code.slice(declStart, item.end).trim();
    const nm = /([A-Za-z_$][\w$]*)\s*((?:\[\s*\])*)\s*$/.exec(decl);
    if (!nm) continue;
    const name = nm[1];
    const arr = nm[2] ? nm[2].replace(/\s+/g, '') : '';
    const type = decl.slice(0, nm.index).trim();
    if (!type) continue;
    out.push({ name, type: type + arr, annotations, modifiers: '', memberStart: item.start });
  }
  return out;
}

function javaMembers(code: Code, start: number, end: number): { fields: FieldInfo[]; getters: FieldInfo[] } {
  const m = code.masked;
  const fields: FieldInfo[] = [];
  const getters: FieldInfo[] = [];
  let pos = start;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const memberStart = pos;
    const { annotations, declStart } = readAnnotations(code, pos, end);
    const modifiers = m.slice(pos, declStart);
    let i = declStart;
    let bodyBrace = -1;
    let semi = -1;
    while (i < end) {
      const c = m[i];
      if (c === '(' || c === '[') {
        const cl = code.closing(i);
        i = cl < 0 ? end : cl + 1;
        continue;
      }
      if (c === '{') {
        bodyBrace = i;
        break;
      }
      if (c === ';') {
        semi = i;
        break;
      }
      i++;
    }
    let memberEnd: number;
    let declText: string;
    if (bodyBrace >= 0) {
      const cl = code.closing(bodyBrace);
      memberEnd = cl < 0 ? end : cl + 1;
      declText = code.slice(declStart, bodyBrace);
    } else if (semi >= 0) {
      memberEnd = semi + 1;
      declText = code.slice(declStart, semi);
    } else {
      memberEnd = end;
      declText = code.slice(declStart, end);
    }
    pos = memberEnd;
    if (/^\s*(?:class|interface|enum|record)\b/.test(declText)) continue;
    const eq = topLevelEq(declText);
    const beforeEq = eq < 0 ? declText : declText.slice(0, eq);
    if (beforeEq.includes('(')) {
      // A method. Only annotated no-arg getters matter (property-access mapping).
      if (annotations.length) {
        const getter = parseJavaGetter(beforeEq);
        if (getter) getters.push({ name: getter.name, type: getter.type, annotations, modifiers, memberStart });
      }
      continue;
    }
    const init = eq < 0 ? undefined : declText.slice(eq + 1).trim();
    for (const d of parseJavaDeclarators(beforeEq)) {
      fields.push({ name: d.name, type: d.type, annotations, modifiers, initializer: init, memberStart });
    }
  }
  return { fields, getters };
}

/** `public Long getId()` / `boolean isActive()` → property `id` / `active` with its return type. */
function parseJavaGetter(decl: string): { name: string; type: string } | undefined {
  const gm = /([A-Za-z_$][\w$.]*(?:\s*<[^;{}]*>)?(?:\s*\[\s*\])*)\s+(get|is)([A-Z]\w*)\s*\(\s*\)\s*$/.exec(decl.trim());
  if (!gm) return undefined;
  const type = gm[1].replace(/\s+/g, '');
  if (type === 'void' || type === 'Void') return undefined;
  return { name: lcfirst(gm[3]), type };
}

function topLevelEq(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '=') {
      const n = s[i + 1];
      const p = s[i - 1];
      if (n !== '=' && p !== '=' && p !== '!' && p !== '<' && p !== '>') return i;
    }
  }
  return -1;
}

function parseJavaDeclarators(beforeEq: string): { type: string; name: string }[] {
  const parts = splitAngle(beforeEq.replace(/;+\s*$/, '')); // splits on top-level commas
  const out: { type: string; name: string }[] = [];
  let lastType = '';
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const nm = /([A-Za-z_$][\w$]*)\s*((?:\[\s*\])*)\s*$/.exec(t);
    if (!nm) continue;
    const name = nm[1];
    const arr = nm[2] ? nm[2].replace(/\s+/g, '') : '';
    let type = t.slice(0, nm.index).trim();
    if (type) {
      lastType = type + arr;
      type = lastType;
    } else {
      type = lastType; // `int a, b` – reuse the previous type for `b`
    }
    if (!type) continue;
    out.push({ type, name });
  }
  return out;
}

function kotlinCtorProps(code: Code, ctorOpen: number): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const item of code.items(ctorOpen)) {
    const { annotations, declStart } = readAnnotations(code, item.start, item.end);
    const prop = parseKotlinProperty(code, declStart, item.end);
    if (!prop) continue;
    out.push({ ...prop, annotations, modifiers: code.masked.slice(item.start, declStart), memberStart: item.start });
  }
  return out;
}

function kotlinBodyProps(code: Code, start: number, end: number): FieldInfo[] {
  const m = code.masked;
  const out: FieldInfo[] = [];
  let pos = start;
  let pending: JvmAnnotation[] = [];
  let pendingStart = -1;
  while (pos < end) {
    while (pos < end && isWs(m[pos])) pos++;
    if (pos >= end) break;
    const c = m[pos];
    if (c === '@') {
      const ann = readAnnotations(code, pos, end);
      if (ann.annotations.length) {
        if (pendingStart < 0) pendingStart = pos;
        pending.push(...ann.annotations);
      }
      pos = ann.declStart > pos ? ann.declStart : pos + 1;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      const cl = code.closing(pos);
      pos = cl < 0 ? end : cl + 1;
      pending = [];
      pendingStart = -1;
      continue;
    }
    const w = WORD_RE.exec(m.slice(pos, pos + 40));
    if (!w) {
      pos++;
      continue;
    }
    const word = w[0];
    if (word === 'val' || word === 'var') {
      const memberStart = pendingStart >= 0 ? pendingStart : pos;
      const prop = parseKotlinProperty(code, pos, end);
      if (prop) out.push({ ...prop, annotations: pending, modifiers: '', memberStart });
      pos = prop ? prop.propEnd : pos + word.length;
      pending = [];
      pendingStart = -1;
      continue;
    }
    if (word === 'fun' || word === 'init' || word === 'constructor' || word === 'companion' || TYPE_KEYWORDS.has(word)) {
      pos = skipConstruct(code, pos + word.length, end);
      pending = [];
      pendingStart = -1;
      continue;
    }
    pos += word.length;
    if (!MODIFIER_WORDS.has(word)) {
      pending = [];
      pendingStart = -1;
    }
  }
  return out;
}

function parseKotlinProperty(
  code: Code,
  from: number,
  limit: number,
): { name: string; type: string; initializer?: string; propEnd: number } | undefined {
  const m = code.masked;
  const kw = /^(val|var)\b/.exec(m.slice(from, from + 4));
  if (!kw) return undefined;
  let i = from + kw[0].length;
  while (i < limit && isWs(m[i])) i++;
  const nameM = /^([A-Za-z_]\w*)/.exec(m.slice(i, i + 80));
  if (!nameM) return undefined;
  const name = nameM[1];
  i += nameM[0].length;
  while (i < limit && isWs(m[i])) i++;
  let type = '';
  if (m[i] === ':') {
    i++;
    const tEnd = scanTo(code, i, limit, { stopAt: '={', newline: true });
    type = code.slice(i, tEnd).trim();
    i = tEnd;
    while (i < limit && isWs(m[i])) i++;
  }
  let initializer: string | undefined;
  if (m[i] === '=' && m[i + 1] !== '=') {
    i++;
    const vEnd = scanTo(code, i, limit, { stopAt: '', newline: true });
    initializer = code.slice(i, vEnd).trim();
    i = vEnd;
  }
  return { name, type, initializer, propEnd: i };
}

/** Scans from `from` to the first depth-0 char in `stopAt`, or a depth-0 newline when `newline`. */
function scanTo(code: Code, from: number, limit: number, opts: { stopAt: string; newline: boolean }): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && m[i - 1] !== '-' && m[i - 1] !== '=') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === '=' && m[i + 1] === '=') {
        i++;
        continue;
      }
      if (opts.stopAt.includes(c)) return i;
      if (opts.newline && c === '\n') return i;
    }
  }
  return limit;
}

function skipConstruct(code: Code, from: number, limit: number): number {
  const m = code.masked;
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = m[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === '{') {
        const cl = code.closing(i);
        return cl < 0 ? limit : cl + 1;
      }
      if (c === '\n') {
        // function expression body `fun f() = x` or abstract member – ends at the line.
        let p = i - 1;
        while (p >= from && isWs(m[p])) p--;
        if (m[p] !== '=' && m[p] !== ',' && m[p] !== '(') return i;
      }
    }
  }
  return limit;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Annotation value helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function namedString(code: Code, ann: JvmAnnotation | undefined, key: string): string | undefined {
  if (!ann || ann.open < 0) return undefined;
  const span = code.args(ann.open).named.get(key);
  return span ? stringValue(span.text) : undefined;
}

function namedBool(code: Code, ann: JvmAnnotation | undefined, key: string): boolean | undefined {
  if (!ann || ann.open < 0) return undefined;
  const span = code.args(ann.open).named.get(key);
  return span ? boolValue(span.text) : undefined;
}

function firstString(code: Code, ann: JvmAnnotation | undefined): string | undefined {
  if (!ann || ann.open < 0) return undefined;
  const pos = code.args(ann.open).positional;
  return pos.length ? stringValue(pos[0].text) : undefined;
}

/** `@Inheritance(strategy = InheritanceType.JOINED)` → `JOINED`, else undefined. */
function inheritanceStrategy(code: Code, t: TypeDecl): string | undefined {
  const ann = findAnnotation(t.annotations, 'Inheritance');
  if (!ann || ann.open < 0) return undefined;
  const args = code.args(ann.open);
  const text = (args.named.get('strategy') ?? args.positional[0])?.text ?? '';
  const m = /\b(JOINED|TABLE_PER_CLASS|SINGLE_TABLE)\b/.exec(text);
  return m ? m[1] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  code: Code;
  lang: Lang;
  file: string;
  entities: RawEntity[];
  relations: RawRelation[];
  enums: RawEnum[];
  entityNames: Set<string>;
  superNames: Set<string>;
  enumNames: Set<string>;
  embeddables: Map<string, Column[]>;
  springData: boolean;
  /** Model names whose `@Inheritance` strategy gives each subclass its own table (JOINED / TABLE_PER_CLASS). */
  multiTableParents: Set<string>;
}

function parse(file: SourceFile): ParseResult {
  const result: ParseResult = { origin: 'definition', entities: [], relations: [], enums: [] };
  const lang: Lang = extOf(file.path) === '.kt' ? 'kotlin' : 'java';
  const code = new Code(file.text, lang);
  const springData = /org\.springframework\.data\.relational/.test(file.text) || /@MappedCollection\b/.test(file.text);
  const types = discoverTypes(code, lang);

  const ctx: Ctx = {
    code,
    lang,
    file: file.path,
    entities: result.entities,
    relations: result.relations,
    enums: result.enums,
    entityNames: new Set(),
    superNames: new Set(),
    enumNames: new Set(),
    embeddables: new Map(),
    springData,
    multiTableParents: new Set(),
  };

  for (const t of types) {
    if (t.isEnum) ctx.enumNames.add(t.name);
    else if (hasAnnotation(t.annotations, 'Entity') || (springData && hasAnnotation(t.annotations, 'Table'))) ctx.entityNames.add(t.name);
    else if (hasAnnotation(t.annotations, 'MappedSuperclass')) ctx.superNames.add(t.name);
    const strategy = inheritanceStrategy(code, t);
    if (strategy === 'JOINED' || strategy === 'TABLE_PER_CLASS') ctx.multiTableParents.add(t.name);
  }

  // Enums first (so columns can reference them), then embeddables, then entities / superclasses.
  for (const t of types) if (t.isEnum) emitEnum(ctx, t);
  for (const t of types) if (hasAnnotation(t.annotations, 'Embeddable')) ctx.embeddables.set(t.name, buildColumns(ctx, t));
  for (const t of types) {
    const entity = hasAnnotation(t.annotations, 'Entity') || (springData && hasAnnotation(t.annotations, 'Table'));
    const mapped = hasAnnotation(t.annotations, 'MappedSuperclass');
    if (entity || mapped) emitEntity(ctx, t, mapped && !entity);
  }

  return result;
}

function emitEnum(ctx: Ctx, t: TypeDecl): void {
  if (t.bodyOpen < 0 || t.bodyClose < 0) return;
  const values = enumValues(ctx.code, t.bodyOpen, t.bodyClose);
  if (!values.length) return;
  ctx.enums.push({ name: t.name, values, source: sourceRef(ctx.file, ctx.code.lineAt(t.declStart)) });
}

function enumValues(code: Code, bodyOpen: number, bodyClose: number): string[] {
  let end = bodyClose;
  const semi = findTop(code, bodyOpen + 1, bodyClose, ';');
  if (semi >= 0) end = semi;
  const out: string[] = [];
  for (const part of code.split(bodyOpen + 1, end, ',')) {
    const idm = /^[A-Za-z_]\w*/.exec(part.text);
    if (idm) out.push(idm[0]);
  }
  return out;
}

/** The table name an entity receives, plus how certain we are of it. */
function tableName(ctx: Ctx, t: TypeDecl): { name: string; schema?: string; certainty: 0 | 1 | 2 } {
  const table = findAnnotation(t.annotations, 'Table');
  if (table) {
    const name = namedString(ctx.code, table, 'name') ?? firstString(ctx.code, table);
    const schema = namedString(ctx.code, table, 'schema');
    if (name) return { name: unquoteIdent(name), schema: schema ? unquoteIdent(schema) : undefined, certainty: 2 };
    if (schema) return { name: defaultTableName('jpa', t.name), schema: unquoteIdent(schema), certainty: 0 };
  }
  const entity = findAnnotation(t.annotations, 'Entity');
  const entityName = namedString(ctx.code, entity, 'name') ?? firstString(ctx.code, entity);
  if (entityName) return { name: defaultTableName('jpa', entityName), certainty: 1 };
  return { name: defaultTableName('jpa', t.name), certainty: 0 };
}

function emitEntity(ctx: Ctx, t: TypeDecl, mapped: boolean): void {
  const { code, file } = ctx;
  const tn = tableName(ctx, t);
  const columns = buildColumns(ctx, t);
  const indexes = mapped ? [] : collectIndexes(ctx, t);
  const comment = entityComment(code, t);

  const extendsNames = t.extendsNames;
  const ownTable = !!findAnnotation(t.annotations, 'Table') && tn.certainty === 2;
  const disc = hasAnnotation(t.annotations, 'DiscriminatorValue');
  // JOINED / TABLE_PER_CLASS (on a known parent) or an explicit @PrimaryKeyJoinColumn give the
  // subclass its own table; only SINGLE_TABLE (the default) merges it into the parent.
  const ownTableInheritance =
    hasAnnotation(t.annotations, 'PrimaryKeyJoinColumn') || extendsNames.some((e) => ctx.multiTableParents.has(e));
  const sharedTable = !mapped && extendsNames.length > 0 && (!ownTable || disc) && !ownTableInheritance;

  const entity: RawEntity = {
    name: tn.name,
    kind: 'table',
    modelName: t.name,
    nameCertainty: tn.certainty,
    columns,
    source: sourceRef(file, code.lineAt(t.declStart)),
  };
  if (tn.schema) entity.schema = tn.schema;
  if (indexes.length) entity.indexes = indexes;
  if (comment) entity.comment = comment;
  if (mapped) entity.abstract = true;
  if (extendsNames.length) entity.extends = [...new Set(extendsNames)];
  if (sharedTable) entity.sharedTable = true;
  ctx.entities.push(entity);

  // Associations.
  for (const f of collectFields(code, t, ctx.lang)) emitAssociation(ctx, t, f);
}

/** Builds plain columns for a class, flattening in-file `@Embedded` fields and skipping associations. */
function buildColumns(ctx: Ctx, t: TypeDecl): Column[] {
  const { code } = ctx;
  const out: Column[] = [];
  for (const f of collectFields(code, t, ctx.lang)) {
    const mods = f.modifiers;
    if (/\bstatic\b/.test(mods) || /\btransient\b/.test(mods)) continue;
    if (hasAnnotation(f.annotations, 'Transient')) continue;
    if (isAssociation(f)) continue;
    if (hasAnnotation(f.annotations, 'ElementCollection')) continue;
    if (hasAnnotation(f.annotations, 'Embedded') || hasAnnotation(f.annotations, 'EmbeddedId')) {
      const embedded = ctx.embeddables.get(simpleName(f.type));
      if (embedded) {
        const asId = hasAnnotation(f.annotations, 'EmbeddedId');
        for (const c of embedded) out.push(asId ? { ...c, primaryKey: true, nullable: false } : { ...c });
      }
      continue;
    }
    out.push(buildColumn(ctx, f));
  }
  return out;
}

function buildColumn(ctx: Ctx, f: FieldInfo): Column {
  const { code } = ctx;
  const colAnn = findAnnotation(f.annotations, 'Column');
  const explicitName = namedString(code, colAnn, 'name') ?? (ctx.springData ? firstString(code, colAnn) : undefined);
  const name = (explicitName !== undefined ? unquoteIdent(explicitName) : undefined) ?? snakeCase(f.name);
  const simple = simpleName(f.type);
  const props: Partial<Column> = {
    nullable: columnNullable(ctx, f),
    primaryKey: hasAnnotation(f.annotations, 'Id') || hasAnnotation(f.annotations, 'EmbeddedId'),
    unique: namedBool(code, colAnn, 'unique') === true,
  };
  if (
    hasAnnotation(f.annotations, 'GeneratedValue') ||
    hasAnnotation(f.annotations, 'CreationTimestamp') ||
    hasAnnotation(f.annotations, 'UpdateTimestamp') ||
    hasAnnotation(f.annotations, 'GenericGenerator')
  ) {
    props.generated = true;
  }
  const comment = fieldComment(code, f);
  if (comment) props.comment = comment;
  const def = defaultLiteral(f.initializer);
  if (def !== undefined) props.default = def;
  if (ctx.enumNames.has(simple)) props.enumRef = simple;
  props.source = sourceRef(ctx.file, code.lineAt(f.memberStart));
  return column(name, simple, props);
}

function columnNullable(ctx: Ctx, f: FieldInfo): boolean {
  const anns = f.annotations;
  if (hasAnnotation(anns, 'Id') || hasAnnotation(anns, 'EmbeddedId')) return false;
  const col = findAnnotation(anns, 'Column');
  const explicit = namedBool(ctx.code, col, 'nullable');
  if (explicit !== undefined) return explicit;
  if (hasAnnotation(anns, 'NotNull') || hasAnnotation(anns, 'NonNull')) return false;
  if (ctx.lang === 'kotlin') return f.type.trim().endsWith('?');
  return !PRIMITIVES.has(simpleName(f.type));
}

const ASSOCIATION_ANNS = ['ManyToOne', 'OneToMany', 'ManyToMany', 'OneToOne', 'MappedCollection'];

function isAssociation(f: FieldInfo): boolean {
  return ASSOCIATION_ANNS.some((a) => hasAnnotation(f.annotations, a));
}

/** FK column names (and referenced columns) from `@JoinColumn` or composite `@JoinColumns({…})`. */
function joinColumnRefs(ctx: Ctx, f: FieldInfo): { cols: string[]; refs: string[] } {
  const { code } = ctx;
  const cols: string[] = [];
  const refs: string[] = [];
  const push = (ann: JvmAnnotation | undefined) => {
    const n = ann ? namedString(code, ann, 'name') ?? firstString(code, ann) : undefined;
    if (!n) return;
    cols.push(unquoteIdent(n));
    const r = namedString(code, ann, 'referencedColumnName');
    if (r) refs.push(unquoteIdent(r));
  };
  const multi = findAnnotation(f.annotations, 'JoinColumns');
  if (multi && multi.open >= 0) {
    const close = code.closing(multi.open);
    if (close >= 0) for (const sub of subAnnotations(code, multi.open + 1, close, 'JoinColumn')) push(sub);
  }
  if (!cols.length) push(findAnnotation(f.annotations, 'JoinColumn'));
  return { cols, refs };
}

function emitAssociation(ctx: Ctx, t: TypeDecl, f: FieldInfo): void {
  const { code, file } = ctx;
  const line = code.lineAt(f.memberStart);
  const src = sourceRef(file, line);
  const self = { model: t.name };
  const manyToOne = findAnnotation(f.annotations, 'ManyToOne');
  const oneToOne = findAnnotation(f.annotations, 'OneToOne');
  const oneToMany = findAnnotation(f.annotations, 'OneToMany');
  const manyToMany = findAnnotation(f.annotations, 'ManyToMany');
  const join = findAnnotation(f.annotations, 'JoinColumn');

  if (manyToOne || oneToOne) {
    const mappedBy = namedString(code, oneToOne, 'mappedBy');
    if (mappedBy) return; // inverse side – skip
    const target = simpleName(f.type);
    const { cols, refs } = joinColumnRefs(ctx, f);
    const fkCols = cols.length ? cols : [`${snakeCase(f.name)}_id`];
    const notNull =
      namedBool(code, manyToOne ?? oneToOne, 'optional') === false ||
      namedBool(code, join, 'nullable') === false ||
      hasAnnotation(f.annotations, 'NotNull') ||
      hasAnnotation(f.annotations, 'Id');
    const nullable = ctx.lang === 'kotlin' ? f.type.trim().endsWith('?') && !notNull : !notNull;
    const isId = hasAnnotation(f.annotations, 'Id');
    for (const c of fkCols) addFkColumn(ctx, t, c, { nullable, primaryKey: isId });
    ctx.relations.push({
      from: self,
      fromColumns: fkCols,
      to: { model: target },
      toColumns: refs,
      cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
      kind: 'orm',
      optional: nullable,
      source: src,
    });
    return;
  }

  if (oneToMany) {
    const target = collectionElement(f.type) ?? simpleName(f.type);
    if (!target) return;
    const mappedBy = namedString(code, oneToMany, 'mappedBy');
    const joinName = namedString(code, join, 'name');
    const toColumns = joinName ? [joinName] : mappedBy ? [`${snakeCase(mappedBy)}_id`] : [];
    ctx.relations.push({
      from: self,
      fromColumns: [],
      to: { model: target },
      toColumns,
      cardinality: 'one-to-many',
      kind: 'orm',
      source: src,
    });
    return;
  }

  if (manyToMany) {
    const mappedBy = namedString(code, manyToMany, 'mappedBy');
    if (mappedBy) return; // inverse side – skip
    const target = collectionElement(f.type) ?? simpleName(f.type);
    if (!target) return;
    const joinTable = findAnnotation(f.annotations, 'JoinTable');
    const ownerTable = tableName(ctx, t).name;
    const throughName =
      namedString(code, joinTable, 'name') ?? `${ownerTable}_${defaultTableName('jpa', target)}`;
    ctx.relations.push({
      from: self,
      fromColumns: [],
      to: { model: target },
      toColumns: [],
      cardinality: 'many-to-many',
      kind: 'orm',
      through: { name: throughName },
      source: src,
    });
    return;
  }

  // Spring Data JDBC @MappedCollection(idColumn = …) – a one-to-many on the child.
  const mapped = findAnnotation(f.annotations, 'MappedCollection');
  if (mapped) {
    const target = collectionElement(f.type) ?? simpleName(f.type);
    const idColumn = namedString(code, mapped, 'idColumn');
    if (target) {
      ctx.relations.push({
        from: self,
        fromColumns: [],
        to: { model: target },
        toColumns: idColumn ? [idColumn] : [],
        cardinality: 'one-to-many',
        kind: 'orm',
        source: src,
      });
    }
  }
}

function addFkColumn(ctx: Ctx, t: TypeDecl, name: string, props: { nullable: boolean; primaryKey: boolean }): void {
  const entity = ctx.entities.find((e) => e.modelName === t.name);
  if (!entity) return;
  if (entity.columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
  entity.columns.push(column(name, '', { nullable: props.nullable, primaryKey: props.primaryKey }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Indexes, comments, defaults
// ─────────────────────────────────────────────────────────────────────────────────────────────

function collectIndexes(ctx: Ctx, t: TypeDecl): NonNullable<RawEntity['indexes']> {
  const table = findAnnotation(t.annotations, 'Table');
  if (!table || table.open < 0) return [];
  const { code } = ctx;
  const close = code.closing(table.open);
  if (close < 0) return [];
  const out: NonNullable<RawEntity['indexes']> = [];
  const line = code.lineAt(table.open);
  for (const sub of subAnnotations(code, table.open + 1, close, 'Index')) {
    const columnList = namedString(code, sub, 'columnList');
    if (!columnList) continue;
    const cols = columnList
      .split(',')
      .map((c) => c.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (!cols.length) continue;
    const name = namedString(code, sub, 'name');
    out.push({ columns: cols, unique: namedBool(code, sub, 'unique') === true, ...(name ? { name } : {}), source: sourceRef(ctx.file, line) });
  }
  for (const sub of subAnnotations(code, table.open + 1, close, 'UniqueConstraint')) {
    const cols = arrayStrings(code, sub, 'columnNames');
    if (!cols.length) continue;
    const name = namedString(code, sub, 'name');
    out.push({ columns: cols, unique: true, ...(name ? { name } : {}), source: sourceRef(ctx.file, line) });
  }
  return out;
}

/** Finds nested annotations of the given simple name within `[from, to)`. */
function subAnnotations(code: Code, from: number, to: number, name: string): JvmAnnotation[] {
  const m = code.masked;
  const out: JvmAnnotation[] = [];
  const needle = '@' + name;
  let i = from;
  for (;;) {
    const at = m.indexOf(needle, i);
    if (at < 0 || at >= to) break;
    const next = m[at + needle.length];
    if (next === undefined || !/[\w$]/.test(next)) {
      let q = at + needle.length;
      while (q < to && isWs(m[q])) q++;
      out.push({ name, raw: name, start: at, open: m[q] === '(' ? q : -1 });
    }
    i = at + needle.length;
  }
  return out;
}

function arrayStrings(code: Code, ann: JvmAnnotation, key: string): string[] {
  if (ann.open < 0) return [];
  const span = code.args(ann.open).named.get(key);
  if (!span) return [];
  const open = code.masked.indexOf('{', span.start);
  if (open < 0 || open >= span.end) {
    const single = stringValue(span.text);
    return single ? [single] : [];
  }
  return code
    .items(open)
    .map((p) => stringValue(p.text))
    .filter((s): s is string => s !== undefined);
}

function entityComment(code: Code, t: TypeDecl): string | undefined {
  const raw = code.leadingComments(t.declStart);
  return raw.length ? cleanDoc(raw) : undefined;
}

function fieldComment(code: Code, f: FieldInfo): string | undefined {
  const raw = code.leadingComments(f.memberStart);
  return raw.length ? cleanDoc(raw) : undefined;
}

function cleanDoc(lines: string[]): string | undefined {
  const text = lines
    .join('\n')
    .replace(/^\s*\/\*+/, '')
    .replace(/\*+\/\s*$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\/\/+|\*(?!\/)|#)\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return text || undefined;
}

function defaultLiteral(init: string | undefined): string | undefined {
  if (init === undefined) return undefined;
  const s = init.trim();
  if (!s) return undefined;
  const str = stringValue(s);
  if (str !== undefined) return str;
  if (numberValue(s) !== undefined) return s;
  if (boolValue(s) !== undefined) return s;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Detect + export
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detect(file: SourceFile): boolean {
  const t = file.text;
  if (/\borg\.jetbrains\.exposed\b/.test(t)) return false; // Exposed Kotlin DSL – not JPA
  if (/@Entity\b/.test(t) || /@MappedSuperclass\b/.test(t) || /@Embeddable\b/.test(t)) return true;
  if (/@Table\b/.test(t) && (/\b(?:jakarta|javax)\.persistence\b/.test(t) || /org\.springframework\.data\.relational/.test(t))) return true;
  if (/@MappedCollection\b/.test(t) && /@Id\b/.test(t)) return true;
  return false;
}

export const jpaParser: SchemaParser = {
  kind: 'jpa',
  extensions: ['.java', '.kt'],
  detect,
  parse,
};
