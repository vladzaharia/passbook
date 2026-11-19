import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runbookSql, singleSelect } from './baked-sync-wait.ts';
import { unmigratedWalletAccounts, walletMigrationRefusal } from './wallet-migrate-gate.ts';

describe('wallet migration gate', () => {
  it('the runbook query is a single SELECT the deploy can run remotely', () => {
    const md = readFileSync(resolve(import.meta.dirname, '../../docs/operations.md'), 'utf8');
    expect(singleSelect(runbookSql(md, 'wallet-migration-gate') ?? '')).toMatch(
      /^SELECT a\.id, a\.org_id/,
    );
  });

  it('reads rows and refuses while any is left', () => {
    const rows = unmigratedWalletAccounts(
      JSON.stringify([{ results: [{ id: 'a1', org_id: 'o1', mode: 'live', provider: 'google' }] }]),
    );
    expect(walletMigrationRefusal(rows)).toMatch(/a1 \(org o1, live google\)/);
    expect(walletMigrationRefusal(unmigratedWalletAccounts('[{"results":[]}]'))).toBeNull();
  });

  it('unreadable output is an error, never an empty list', () => {
    expect(() => unmigratedWalletAccounts('{}')).toThrow(/cannot tell/);
    expect(() => unmigratedWalletAccounts('[{"results":[{"x":1}]}]')).toThrow(/cannot tell/);
  });
});
