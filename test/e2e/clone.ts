import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { E2eRepo } from './repos';

/** Clone cache lives outside the repository: `$DBNEXT_E2E_CACHE` or `<tmp>/dbnext-e2e`. */
export function cacheDir(): string {
  return process.env.DBNEXT_E2E_CACHE || join(tmpdir(), 'dbnext-e2e');
}

/** Shallow-fetches exactly one commit; reuses an existing checkout of the same SHA. */
export function ensureClone(r: E2eRepo): string {
  const dir = join(cacheDir(), `${r.id}-${r.sha.slice(0, 12)}`);
  const marker = join(dir, '.dbnext-ok');
  if (existsSync(marker)) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 900_000 });
  git('init', '-q');
  git('remote', 'add', 'origin', `https://github.com/${r.repo}.git`);
  if (r.sparse) {
    git('config', 'extensions.partialClone', 'origin');
    git('sparse-checkout', 'set', ...r.sparse);
    git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', r.sha);
  } else {
    git('fetch', '-q', '--depth', '1', 'origin', r.sha);
  }
  git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
  writeFileSync(marker, ''); // written last so an interrupted clone is retried
  return dir;
}
