/**
 * Theme helpers for SVG export: collect the webview's own stylesheet text and resolve every
 * `var(--vscode-*)` reference to the concrete colour the current theme computes, so an exported SVG
 * is self-contained and looks the same outside VS Code.
 */

/** Reads a CSS custom property off an element (defaults to document body). */
export function cssVar(name: string, root: Element = document.body): string {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Concatenated text of all same-origin stylesheets (the bundled main.css). */
export function collectStyleSheetText(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin / inaccessible
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) parts.push(rule.cssText);
  }
  return parts.join('\n');
}

const VAR_RE = /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^()]*?))?\)/g;

/** Replaces every `var(--name[, fallback])` in `css` with the resolved value (recursively). */
export function resolveCssVariables(css: string, root: Element = document.body): string {
  const style = getComputedStyle(root);
  const resolveOnce = (text: string): string =>
    text.replace(VAR_RE, (_m, name: string, fallback: string | undefined) => {
      const value = style.getPropertyValue(name).trim();
      if (value) return value;
      return (fallback ?? '').trim();
    });
  let out = css;
  for (let i = 0; i < 5 && VAR_RE.test(out); i++) out = resolveOnce(out);
  return out;
}
