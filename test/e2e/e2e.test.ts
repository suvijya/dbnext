/**
 * Real-repo regression suite. Not part of `npm test`; run with `npm run test:e2e`
 * (`npm run test:e2e -- --update` refreshes the committed snapshots in test/e2e/snapshots).
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureClone } from './clone';
import { REPOS } from './repos';
import { scanDir, summarize } from './scan';

describe('real repositories', () => {
  for (const r of REPOS) {
    it(`${r.id} (${r.note})`, { timeout: 900_000 }, async () => {
      const dir = ensureClone(r);
      const summary = summarize(scanDir(dir, r.id));
      await expect(summary).toMatchFileSnapshot(join(__dirname, 'snapshots', `${r.id}.txt`));
    });
  }
});
