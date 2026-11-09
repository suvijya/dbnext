/** Display helper for untrusted text. DOM-free. */
/** Display form of untrusted text: control characters replaced, long strings cut with an ellipsis (code-point safe). */
export function clip(text: string, max = 40): string {
  const s = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : s;
}

