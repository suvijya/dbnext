/**
 * Text measurement with a canvas 2D context, using the editor's actual fonts so card widths fit
 * their content in every theme.
 */

export interface Fonts {
  uiFamily: string;
  uiSize: number;
  monoFamily: string;
  monoSize: number;
}

export function readFonts(root: Element): Fonts {
  const cs = getComputedStyle(root);
  const num = (v: string, fallback: number): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const uiFamily = cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
  const monoFamily = cs.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
  const uiSize = num(cs.getPropertyValue('--vscode-font-size'), 13);
  return { uiFamily, uiSize, monoFamily, monoSize: Math.max(11, uiSize - 1) };
}

export class Measurer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache = new Map<string, number>();

  constructor(private readonly fonts: Fonts) {
    const canvas = document.createElement('canvas');
    this.ctx = canvas.getContext('2d')!;
  }

  private measure(text: string, font: string): number {
    const key = `${font}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    this.ctx.font = font;
    const w = this.ctx.measureText(text).width;
    if (this.cache.size < 20000) this.cache.set(key, w);
    return w;
  }

  ui(text: string, weight: 'normal' | 'bold' = 'normal'): number {
    return this.measure(text, `${weight === 'bold' ? '600 ' : ''}${this.fonts.uiSize}px ${this.fonts.uiFamily}`);
  }

  mono(text: string): number {
    return this.measure(text, `${this.fonts.monoSize}px ${this.fonts.monoFamily}`);
  }

  get uiSize(): number {
    return this.fonts.uiSize;
  }

  get monoSize(): number {
    return this.fonts.monoSize;
  }
}
