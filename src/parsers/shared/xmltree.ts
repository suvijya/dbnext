/**
 * Tiny tolerant XML reader used by the mapping-file parsers (Hibernate `hbm.xml`, Doctrine XML).
 * Builds an element tree with 0-based line numbers. Never throws: unclosed elements are closed at
 * the end of the input and stray closing tags are ignored. Pure and linear in the input size.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 0-based line of the opening tag. */
  line: number;
}

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.includes('&') ? s.replace(/&(lt|gt|amp|quot|apos);/g, (_m, e: string) => ENTITIES[e]) : s;
}

const TAG = /<(\/)?([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/y;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses `text` into a synthetic root node whose children are the top-level elements. */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], line: 0 };
  const stack: XmlNode[] = [root];
  let line = 0;
  let pos = 0;
  const n = text.length;

  /** Advances the line counter over `text[from, to)`. */
  const countLines = (from: number, to: number): void => {
    for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) line++;
  };

  while (pos < n) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) break;
    countLines(pos, lt);
    pos = lt;
    // Comments, CDATA, processing instructions and DOCTYPE are skipped.
    let skipTo = -1;
    let terminator = '';
    if (text.startsWith('<!--', lt)) terminator = '-->';
    else if (text.startsWith('<![CDATA[', lt)) terminator = ']]>';
    else if (text.startsWith('<?', lt)) terminator = '?>';
    else if (text.startsWith('<!', lt)) terminator = '>';
    if (terminator) {
      const end = text.indexOf(terminator, lt + 2);
      skipTo = end < 0 ? n : end + terminator.length;
      countLines(lt, skipTo);
      pos = skipTo;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (!m) {
      pos = lt + 1;
      continue;
    }
    if (m[1]) {
      // Closing tag: pop up to the matching open element (ignored when there is none).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) {
          stack.length = i;
          break;
        }
      }
    } else {
      const node: XmlNode = { name: m[2], attrs: {}, children: [], line };
      ATTR.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(m[3]))) node.attrs[a[1]] = unescape(a[2] ?? a[3] ?? '');
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
    }
    countLines(lt, lt + m[0].length);
    pos = lt + m[0].length;
  }
  return root;
}

/** Child elements of `node` with the given name. */
export function kids(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** First descendant (depth-first) with the given name. */
export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const d = findFirst(c, name);
    if (d) return d;
  }
  return undefined;
}

export const isTrue = (v: string | undefined): boolean => v === 'true' || v === '1';
