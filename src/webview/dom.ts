/**
 * Tiny DOM/SVG construction helpers.
 *
 * SECURITY: everything in the model is scanned from untrusted repositories. These helpers only ever
 * assign text through `textContent` and attributes through `setAttribute`; there is no innerHTML /
 * insertAdjacentHTML / outerHTML path anywhere in the webview.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Child = Node | string | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
}

function applyChildren(node: Element, children?: Child[]): void {
  if (!children) return;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  if (options.type) node.setAttribute('type', options.type);
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      if (v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
  }
  if (options.dataset) {
    for (const [k, v] of Object.entries(options.dataset)) node.dataset[k] = v;
  }
  if (options.on) {
    for (const [k, fn] of Object.entries(options.on)) node.addEventListener(k, fn as EventListener);
  }
  applyChildren(node, children);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  children?: Child[],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  applyChildren(node, children);
  return node;
}

/** SVG text node (text set via textContent — safe for untrusted strings). */
export function svgText(
  content: string,
  attrs: Record<string, string | number | undefined> = {},
): SVGTextElement {
  const t = svg('text', attrs);
  t.textContent = content;
  return t;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(options: Omit<ElOptions, 'text'> & { label?: string; icon?: Node } = {}): HTMLButtonElement {
  const b = el('button', { class: options.class, title: options.title, attrs: options.attrs, dataset: options.dataset, on: options.on, type: options.type ?? 'button' });
  if (options.icon) b.appendChild(options.icon);
  if (options.label !== undefined) b.appendChild(document.createTextNode(options.label));
  return b;
}
