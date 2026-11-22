// CW9b: a Google object retires once its revocation was read back inactive (0198, G5), and not before.
import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { completeWalletOperation } from './instance.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { runtimeGoogleLegacyFixture } from './runtime-integration-fixtures.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
const makeEnv = installKeysetTestEnv();

async function revoked(confirmed: boolean) {
  const f = await runtimeGoogleLegacyFixture({ db: (await makeEnv()).DB });
  const db = f.kit.env.DB;
  const claim = {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'google' as const,
    instanceId: f.instanceId,
    version: 1,
    claimHandle: f.claimHandle,
    now: f.kit.clock.now(),
  };
  const state = await completeWalletOperation(jobCtxOf(f.kit), {
    ...claim,
    result: { kind: 'success', httpStatus: 200, ...(confirmed ? { confirmed: true } : {}) },
  });
  return { f, db, claim, state };
}
const instance = (db: D1Database, id: string) =>
  first<{ lifecycle: string; retirement_settled_at: number | null }>(
    db,
    'SELECT lifecycle, retirement_settled_at FROM wallet_provider_instances WHERE id = ?',
    [id],
  );

describe('Google retirement', () => {
  it('retires and settles once the revoke was confirmed', async () => {
    const { f, db, claim, state } = await revoked(true);
    expect(state).toBe('succeeded');
    expect(
      await all(db, 'SELECT operation_id, version FROM wallet_google_revocation_confirmations'),
    ).toEqual([{ operation_id: f.operationId, version: 1 }]);
    expect(await finishWalletProviderRetirement(jobCtxOf(f.kit), claim)).toBe(true);
    const row = await instance(db, f.instanceId);
    expect(row?.lifecycle).toBe('retired');
    expect(row?.retirement_settled_at).not.toBeNull();
    // A replay of the same acknowledgement is answered, not repeated.
    expect(await finishWalletProviderRetirement(jobCtxOf(f.kit), claim)).toBe(true);
  });

  it('holds an accepted PUT that was never read back', async () => {
    const { f, db, claim, state } = await revoked(false);
    expect(state).toBe('succeeded');
    expect(await all(db, 'SELECT 1 FROM wallet_google_revocation_confirmations')).toEqual([]);
    expect(await finishWalletProviderRetirement(jobCtxOf(f.kit), claim)).toBe(false);
    expect(await instance(db, f.instanceId)).toEqual({
      lifecycle: 'revoked',
      retirement_settled_at: null,
    });
    // Nor can the database be told otherwise.
    await expect(
      run(
        db,
        "UPDATE wallet_provider_instances SET lifecycle = 'retired', retired_at = 1 WHERE id = ?",
        [f.instanceId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a confirmation for an operation that is not a claimed revoke, and edits to one', async () => {
    const { f, db } = await revoked(true);
    const keyset = await first<{ credential_keyset_commitment: string }>(
      db,
      'SELECT credential_keyset_commitment FROM wallet_provider_instances WHERE id = ?',
      [f.instanceId],
    );
    // The operation has succeeded: it is no longer claimed, so a second confirmation is refused.
    await expect(
      run(
        db,
        `INSERT INTO wallet_google_revocation_confirmations
        (operation_id, instance_id, version, confirmed_at, credential_keyset_commitment) VALUES (?, ?, 1, 2, ?)`,
        [crypto.randomUUID(), f.instanceId, keyset?.credential_keyset_commitment],
      ),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE wallet_google_revocation_confirmations SET confirmed_at = 9', []),
    ).rejects.toThrow(/immutable/);
  });
});
