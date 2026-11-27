import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_SQLITE,
  findFailures,
  fingerprint,
  judge,
  openOracle,
  readAllowlist,
} from './check-sql-depth.ts';

const root = join(import.meta.dirname, '..');
const probe = readFileSync(join(import.meta.dirname, 'fixtures/sql-depth-probe.sql'), 'utf8');

describe('SQL depth oracle', () => {
  it('is the SQLite build with the cursor-count rule, and rejects the probe', async () => {
    const oracle = await openOracle();
    expect(oracle.version).toBe(EXPECTED_SQLITE);
    expect(oracle.check(probe)).toMatch(/nested too deep/);
    expect(oracle.check('SELECT id FROM orgs WHERE id = ?')).toBeNull();
  });

  it('reports a failing statement with its first test', async () => {
    const oracle = await openOracle();
    const found = findFailures(oracle, [
      { sql: 'SELECT 1', test: 'a' },
      { sql: probe, test: 'b' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.test).toBe('b');
    expect(found[0]?.fingerprint).toBe(fingerprint(probe));
  });

  it('fingerprints ignore whitespace only', () => {
    expect(fingerprint('SELECT  1\n FROM t')).toBe(fingerprint('SELECT 1 FROM t'));
    expect(fingerprint('SELECT 1')).not.toBe(fingerprint('SELECT 2'));
  });

  it('fails new statements, reports known ones and notices cleared ones', () => {
    const f = (fp: string) => ({ fingerprint: fp, error: 'e', sql: fp, test: null });
    const allow = [
      { fingerprint: 'aaa', error: 'e', sql: 'aaa' },
      { fingerprint: 'bbb', error: 'e', sql: 'bbb' },
    ];
    const verdict = judge([f('aaa'), f('ccc')], allow);
    expect(verdict.known.map((x) => x.fingerprint)).toEqual(['aaa']);
    expect(verdict.fresh.map((x) => x.fingerprint)).toEqual(['ccc']);
    expect(verdict.cleared.map((x) => x.fingerprint)).toEqual(['bbb']);
  });

  it('keeps the allowlist well-formed and free of duplicates', () => {
    const allow = readAllowlist();
    expect(new Set(allow.map((a) => a.fingerprint)).size).toBe(allow.length);
    for (const entry of allow) expect(entry.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('SQL recorder is test-only', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it('is installed by nothing under src/ except tests and db.ts itself', () => {
    const users = files(join(root, 'src'))
      .map((path) => relative(root, path))
      .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
      .filter((rel) => /installSqlRecorder|SQL_CORPUS/.test(readFileSync(join(root, rel), 'utf8')));
    expect(users).toEqual(['src/worker/platform/db.ts']);
  });

  it('has no SQL_CORPUS binding in the deployed Worker config', () => {
    for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
      let text = '';
      try {
        text = readFileSync(join(root, name), 'utf8');
      } catch {
        continue;
      }
      expect(text).not.toContain('SQL_CORPUS');
    }
  });
});
