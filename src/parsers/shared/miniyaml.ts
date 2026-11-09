/**
 * Minimal block-mapping YAML reader for mapping files (Doctrine YAML). Supports nested mappings by
 * indentation, `key: value` scalars, inline `{ a: b, c: d }` mappings and `# comments`. Sequences
 * (`- item`) are ignored. Never throws; linear in the input size.
 */

export interface YamlNode {
  key: string;
  /** Scalar value (unquoted), `''` for a nested mapping. */
  value: string;
  /** 0-based line of the key. */
  line: number;
  children: YamlNode[];
}

function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.length >= 2 && t[t.length - 1] === q) return t.slice(1, -1);
  return t;
}

/** Removes a trailing ` # comment` that is not inside quotes. */
function stripComment(s: string): string {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function flowChildren(value: string, line: number): YamlNode[] | undefined {
  const t = value.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  const nodes: YamlNode[] = [];
  for (const part of splitTop(t.slice(1, -1))) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const v = part.slice(i + 1).trim();
    const kids = flowChildren(v, line);
    nodes.push({ key: unquote(part.slice(0, i)), value: kids ? '' : unquote(v), line, children: kids ?? [] });
  }
  return nodes;
}

/** Parses `text` into the top-level mapping entries. */
export function parseYamlMap(text: string): YamlNode[] {
  const roots: YamlNode[] = [];
  const stack: { indent: number; node: YamlNode }[] = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = stripComment(lines[ln].replace(/\r$/, '')).replace(/\s+$/, '');
    const body = raw.trimStart();
    if (!body || body.startsWith('- ') || body === '-' || body === '---' || body.startsWith('%')) continue;
    const indent = raw.length - body.length;
    const m = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(?:\s+(.*)|)$/.exec(body);
    if (!m) continue;
    const rawValue = (m[2] ?? '').trim();
    const flow = flowChildren(rawValue, ln);
    const node: YamlNode = { key: unquote(m[1]), value: flow ? '' : unquote(rawValue), line: ln, children: flow ?? [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

export function child(node: YamlNode, key: string): YamlNode | undefined {
  return node.children.find((c) => c.key === key);
}

export function childValue(node: YamlNode, key: string): string | undefined {
  const c = child(node, key);
  return c && !c.children.length ? c.value : undefined;
}
