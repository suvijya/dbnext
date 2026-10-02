import { describe, expect, it } from 'vitest';
import type { EngineHint, SourceFile } from '../../../src/core/model';
import { engineDetector } from '../../../src/parsers/engines';

const detect = (path: string, text: string): EngineHint[] => engineDetector.detect({ path, text } as SourceFile);
const engines = (hints: EngineHint[]): string[] => [...new Set(hints.map((h) => h.engine))].sort();

describe('engines — docker compose variable substitution', () => {
  // BUG: image tags using compose variable substitution (`${PG_IMAGE:-postgres:16}`,
  // `postgres:${PG_TAG:-16}`) were not resolved, so the default image / tag was never detected.
  it('resolves ${VAR:-default} in the whole image reference', () => {
    expect(engines(detect('docker-compose.yml', 'services:\n  db:\n    image: ${PG_IMAGE:-postgres:16}'))).toEqual(['postgresql']);
  });

  it('resolves ${VAR:-default} inside the tag', () => {
    expect(engines(detect('docker-compose.yml', 'services:\n  db:\n    image: postgres:${POSTGRES_VERSION:-16}'))).toEqual(['postgresql']);
  });

  it('resolves the ${VAR-default} (no colon) form', () => {
    expect(engines(detect('compose.yaml', 'services:\n  db:\n    image: mariadb:${VER-11}'))).toEqual(['mariadb']);
  });

  it('reports the resolved image in the hint detail', () => {
    const hints = detect('docker-compose.yml', 'services:\n  db:\n    image: ${PG_IMAGE:-postgres:16}');
    expect(hints[0]?.detail).toBe('docker compose image "postgres:16"');
  });

  it('does not guess an engine for an image that is a bare, undefaulted variable', () => {
    expect(detect('docker-compose.yml', 'services:\n  db:\n    image: ${DB_IMAGE}')).toEqual([]);
    expect(detect('docker-compose.yml', 'services:\n  db:\n    image: $DB_IMAGE')).toEqual([]);
  });
});

describe('engines — no credential leakage from connection URLs', () => {
  // The detector must only ever surface the URL *scheme* and the config *key*, never a host,
  // user or password — even for awkward URLs with `@` / query params / `;password=`.
  it('keeps secrets out of the hint detail for tricky URLs', () => {
    const env = [
      'DATABASE_URL=postgres://user:pa@ss@db.internal:5432/app?sslmode=require',
      'JDBC_URL=jdbc:mysql://localhost:3306/app?user=root&password=hunter2',
      'MSSQL=jdbc:sqlserver://host;user=sa;password=S3cr3t!;database=app',
    ].join('\n');
    const hints = detect('.env.example', env);
    expect(engines(hints).length).toBeGreaterThan(0);
    for (const h of hints) {
      for (const secret of ['pa@ss', 'db.internal', 'hunter2', 'S3cr3t', 'root', 'sa']) {
        expect(h.detail.includes(secret), `${h.detail} must not contain ${secret}`).toBe(false);
      }
    }
  });

  it('never reads a real .env file even if asked directly', () => {
    expect(detect('.env', 'DATABASE_URL=postgres://u:p@h/db')).toEqual([]);
    expect(detect('.env.local', 'DATABASE_URL=mysql://u:p@h/db')).toEqual([]);
  });
});

describe('engines — CRLF equivalence', () => {
  it('detects the same engines regardless of line endings', () => {
    const compose = 'services:\n  db:\n    image: ${PG_IMAGE:-postgres:16}\n  cache:\n    image: redis:7\n';
    const lf = detect('docker-compose.yml', compose);
    const crlf = detect('docker-compose.yml', compose.replace(/\n/g, '\r\n'));
    expect(engines(crlf)).toEqual(engines(lf));
    expect(engines(lf)).toEqual(['postgresql', 'redis']);
  });
});
