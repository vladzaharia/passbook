// CW9b: a Google object retires once its revocation was read back (0198, G5), and not before. The read back
// is `inactive` (served back barcode-less) or `absent` (a 404), and its stored response is the evidence.
import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { completeWalletOperation, recordWalletOperationOutcome } from './instance.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { runtimeGoogleLegacyFixture } from './runtime-integration-fixtures.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
const makeEnv = installKeysetTestEnv();

/** The revoke finishes; `read` is the status of the last response the attempt recorded (the read back). */
async function revoked(confirmed: 'inactive' | 'absent' | undefined, read = 200, method = 'GET') {
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
  const ctx = jobCtxOf(f.kit);
  await recordWalletOperationOutcome(ctx, {
    ...claim,
    sequence: 1,
    eventKey: '1:google-object:GET',
    body: new TextEncoder().encode('{}'),
    reason: read < 400 ? 'ok' : 'provider_error',
    httpStatus: read,
    method,
    stage: 'google-object',
  });
  const state = await completeWalletOperation(ctx, {
    ...claim,
    result: { kind: 'success', httpStatus: 200, ...(confirmed ? { confirmed } : {}) },
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
  it.each([
    ['inactive', 200],
    ['absent', 404],
  ] as const)('retires and settles once the revoke was read back %s', async (outcome, read) => {
    const { f, db, claim, state } = await revoked(outcome, read);
    expect(state).toBe('succeeded');
    expect(
      await all(
        db,
        'SELECT operation_id, version, outcome FROM wallet_google_revocation_confirmations',
      ),
    ).toEqual([{ operation_id: f.operationId, version: 1, outcome }]);
    expect(await finishWalletProviderRetirement(jobCtxOf(f.kit), claim)).toBe(true);
    const row = await instance(db, f.instanceId);
    expect(row?.lifecycle).toBe('retired');
    expect(row?.retirement_settled_at).not.toBeNull();
    // A replay of the same acknowledgement is answered, not repeated.
    expect(await finishWalletProviderRetirement(jobCtxOf(f.kit), claim)).toBe(true);
  });

  it('holds an accepted PUT that was never read back', async () => {
    const { f, db, claim, state } = await revoked(undefined);
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

  it('does not take a confirmation whose recorded read says otherwise', async () => {
    // Claims "inactive" over a 404, and "absent" over a 200: the database refuses the pair.
    await expect(revoked('inactive', 404)).rejects.toThrow(/read back/);
    await expect(revoked('absent', 200)).rejects.toThrow(/read back/);
    // A PUT acknowledged with 200 is not a read of the object.
    await expect(revoked('inactive', 200, 'PUT')).rejects.toThrow(/read back/);
  });

  it('keeps the evidence until the instance settles, and never edits it', async () => {
    const { f, db } = await revoked('inactive');
    await expect(run(db, 'DELETE FROM wallet_google_revocation_confirmations', [])).rejects.toThrow(
      /kept until retirement settles/,
    );
    await expect(
      run(db, 'UPDATE wallet_google_revocation_confirmations SET confirmed_at = 9', []),
    ).rejects.toThrow(/immutable/);
    const keyset = await first<{ credential_keyset_commitment: string }>(
      db,
      'SELECT credential_keyset_commitment FROM wallet_provider_instances WHERE id = ?',
      [f.instanceId],
    );
    // The operation has succeeded: it is no longer claimed, so another confirmation is refused.
    await expect(
      run(
        db,
        `INSERT INTO wallet_google_revocation_confirmations
        (operation_id, instance_id, version, outcome, outcome_id, confirmed_at, credential_keyset_commitment)
        VALUES (?, ?, 1, 'inactive', ?, 2, ?)`,
        [crypto.randomUUID(), f.instanceId, 'none', keyset?.credential_keyset_commitment],
      ),
    ).rejects.toThrow();
  });
});
