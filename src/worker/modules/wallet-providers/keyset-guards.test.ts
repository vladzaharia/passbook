import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';

// Provider SQL no longer re-checks the singleton per statement; these guards are what keep it fixed.
describe('credential reference keyset singleton guards', () => {
  it('exist and keep the singleton immutable', async () => {
    const { DB: db } = await makeEnv();
    const triggers = await all<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'credential_ref_keyset'`,
    );
    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'credential_ref_keyset_insert_guard',
        'credential_ref_keyset_no_update',
        'credential_ref_keyset_no_delete',
      ]),
    );
    await run(db, 'INSERT OR IGNORE INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
      'a'.repeat(64),
    ]);
    await expect(
      run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', ['b'.repeat(64)]),
    ).rejects.toThrow('immutable');
    await expect(run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')).rejects.toThrow(
      'immutable',
    );
    await expect(
      run(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (2, ?)', ['c'.repeat(64)]),
    ).rejects.toThrow();
  });
});

// The per-statement keyset checks are gone, so these insert and immutability triggers are what keep a
// foreign commitment out of each provider table. A table rebuild (0114 had to) must bring each one back.
const KEYSET_TRIGGERS: Record<string, string[]> = {
  wallet_provider_instances: [
    'wallet_provider_generation_insert_guard',
    'wallet_provider_instance_keyset_immutable',
  ],
  wallet_provider_instance_operations: [
    'wallet_provider_generation_operation_guard',
    'wallet_provider_operation_keyset_immutable',
  ],
  wallet_google_callback_bindings: [
    'wallet_provider_generation_google_binding',
    'wallet_google_binding_keyset_immutable',
  ],
  wallet_samsung_fetch_refs: ['wallet_samsung_ref_keyset_immutable'],
  wallet_samsung_tombstones: [
    'wallet_samsung_tombstone_keyset_insert',
    'wallet_samsung_tombstone_keyset_immutable',
  ],
  template_candidates: ['wallet_provider_candidate_keyset_insert'],
  template_approvals: ['wallet_provider_approval_keyset_insert'],
  template_releases: ['wallet_provider_release_keyset_insert'],
  wallet_provider_projection_evidence: [
    'wallet_provider_evidence_keyset_insert',
    'wallet_provider_evidence_keyset_update',
  ],
  wallet_provider_projection_evidence_history: ['wallet_provider_evidence_history_keyset_insert'],
};

describe('per-table keyset triggers', () => {
  it('exist on every provider table that stores a commitment', async () => {
    const { DB: db } = await makeEnv();
    for (const [table, names] of Object.entries(KEYSET_TRIGGERS)) {
      const found = await all<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
        [table],
      );
      expect(
        found.map((t) => t.name),
        table,
      ).toEqual(expect.arrayContaining(names));
    }
  });
});
