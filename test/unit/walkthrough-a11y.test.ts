import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('walkthrough manifest', () => {
  const steps = pkg.contributes.walkthroughs?.[0]?.steps ?? [];
  it('has 3-4 steps', () => {
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.length).toBeLessThanOrEqual(4);
  });
  it('only references existing media with alt text', () => {
    for (const s of steps) {
      expect(existsSync(join(root, s.media.image))).toBe(true);
      expect(s.media.altText).toBeTruthy();
    }
  });
  it('only links to contributed or built-in commands', () => {
    const known = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    for (const s of steps) {
      for (const m of s.description.matchAll(/\(command:([\w.]+)/g)) {
        expect(known.has(m[1]) || m[1].startsWith('workbench.')).toBe(true);
      }
    }
  });
});

describe('diagram accessibility', () => {
  it('labels the svg root and exposes selection state', () => {
    const src = readFileSync(join(root, 'src', 'webview', 'diagram.ts'), 'utf8');
    expect(src).toContain("role: 'group'");
    expect(src).toContain("'aria-pressed'");
  });
  it('has forced-colors styles for nodes', () => {
    const css = readFileSync(join(root, 'src', 'webview', 'main.css'), 'utf8');
    expect(css).toMatch(/forced-colors: active\)\s*\{\s*\.node \.card-bg/);
  });
});
