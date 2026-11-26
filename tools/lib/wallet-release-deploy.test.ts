import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anyWalletReleased,
  OPEN_COPIES_SQL,
  RELEASED_SQL,
  walletReleaseRefusal,
} from './wallet-release-deploy.ts';

const flip = (state: string, provider = 'google', mode = 'test') =>
  `UPDATE wallet_provider_releases SET state = '${state}', changed_at = 1 WHERE provider = '${provider}' AND mode = '${mode}';`;
const seed = `INSERT INTO wallet_provider_releases (provider, mode, state, changed_at) VALUES
  ('google', 'test', 'dark', 0);`;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'release-deploy-'));
  mkdirSync(join(root, 'migrations'));
  for (const [name, sql] of Object.entries(files))
    writeFileSync(join(root, 'migrations', name), sql);
  return root;
}
const rows = (results: unknown[]) => JSON.stringify([{ results }]);

function run(files: Record<string, string>, open: unknown[] = []) {
  const root = repo(files);
  const lines: string[] = [];
  const queries: string[] = [];
  const flags = new Set<string>();
  const refusal = walletReleaseRefusal({
    root,
    pending: Object.keys(files),
    log: (l) => lines.push(l),
    remote: (sql) => {
      queries.push(sql);
      return rows(open);
    },
    flags,
  });
  return { refusal, lines, queries, flags };
}

describe('walletReleaseRefusal', () => {
  it('fails closed when the pending list cannot be read', () => {
    const refusal = walletReleaseRefusal({
      root: repo({}),
      pending: null,
      log: () => {},
      remote: () => rows([]),
      flags: new Set(),
    });
    expect(refusal).toMatch(/could not be read/);
  });

  it('prints each write and turns the migration gate on for a flip', () => {
    const r = run({ '0300_flip.sql': flip('released') });
    expect(r.refusal).toBeNull();
    expect(r.lines).toEqual(['Wallet release: google test -> released (0300_flip.sql)']);
    expect([...r.flags]).toEqual(['--require-wallet-migrated']);
    expect(r.queries).toEqual([]);
  });

  it('lets a drain through and asks nothing remote', () => {
    const r = run({ '0300_drain.sql': flip('draining') });
    expect(r.refusal).toBeNull();
    expect(r.flags.size).toBe(0);
    expect(r.queries).toEqual([]);
  });

  it('refuses a dark write while copies remain, and allows it at zero', () => {
    const open = [{ provider: 'google', mode: 'test', open: 3 }];
    const refused = run({ '0301_dark.sql': flip('dark') }, open);
    expect(refused.queries).toEqual([OPEN_COPIES_SQL]);
    expect(refused.refusal).toMatch(/sets google test dark while 3 copies/);
    expect(run({ '0301_dark.sql': flip('dark', 'google', 'live') }, open).refusal).toBeNull();
    expect(run({ '0301_dark.sql': flip('dark') }, []).refusal).toBeNull();
  });

  it('treats the table seed as no change of state', () => {
    const r = run({ '0226_seed.sql': seed }, [{ provider: 'google', mode: 'test', open: 9 }]);
    expect(r.refusal).toBeNull();
    expect(r.queries).toEqual([]);
  });

  it('throws on unreadable remote output', () => {
    const root = repo({ '0301_dark.sql': flip('dark') });
    expect(() =>
      walletReleaseRefusal({
        root,
        pending: ['0301_dark.sql'],
        log: () => {},
        remote: () => 'oops',
        flags: new Set(),
      }),
    ).toThrow();
  });
});

describe('anyWalletReleased', () => {
  it('reads the released rows', () => {
    const seen: string[] = [];
    expect(
      anyWalletReleased((sql) => {
        seen.push(sql);
        return rows([{ provider: 'google', mode: 'test' }]);
      }),
    ).toBe(true);
    expect(seen).toEqual([RELEASED_SQL]);
    expect(anyWalletReleased(() => rows([]))).toBe(false);
  });
});
