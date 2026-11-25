// Architecture 6.1, the Samsung column and the rows both providers share. Google's rows are in
// lifecycle-parity-google.test.ts. Door denial commits before any provider fan-out for every row.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  markWalletClaimUncertain,
  newWalletClaimHandle,
} from './instance.ts';
import type { WalletOperation } from './instance-types.ts';
import { boundaryPhase, nextBoundary, passBoundaries } from './lifecycle-boundary.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { recordSyncLag, WALLET_UPDATE_TARGET_MS } from './sync-lag.ts';
import { samsungOperationState } from './sync-samsung-state.ts';
import { sweepUncertainOperations } from './sync-uncertain.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

type Callbacks = Awaited<ReturnType<typeof setupSamsungCallbacks>>;
const asOperation = (t: Callbacks, patch: Partial<WalletOperation>) =>
  ({ ...t.operation, ...patch }) as WalletOperation;

/** The revoke the instance was last told about, succeeded. */
async function settleRevoke(t: Callbacks) {
  const db = t.kit.env.DB;
  const revoke = await queueWalletOperation(walletJobCtx(db), {
    ...t.operation,
    kind: 'revoke',
    expectedVersion: t.operation.version,
    requestKey: t.kit.ctx.ids.token(32),
    newId: () => t.kit.ctx.ids.id(),
    now: t.kit.clock.now(),
  });
  if (!revoke) throw new Error('Missing revoke fixture');
  const claim = {
    orgId: revoke.orgId,
    mode: revoke.mode,
    provider: 'samsung' as const,
    instanceId: revoke.instanceId,
    version: revoke.version,
    credentialKeysetCommitment: t.credentialKeysetCommitment,
    claimHandle: newWalletClaimHandle(),
    now: t.kit.clock.now(),
  };
  expect(await claimWalletOperation(walletJobCtx(db), claim)).toBe('claimed');
  await completeWalletOperation(jobCtxOf(t.kit), {
    ...claim,
    result: { kind: 'success', httpStatus: 200 },
  });
  return revoke;
}

describe('6.1 Samsung: the state each operation sends', () => {
  it('update: UPDATED, then EXPIRED once the pass has expired', async () => {
    const t = await setupSamsungCallbacks();
    const upsert = asOperation(t, { kind: 'upsert', version: 1 });
    expect(await samsungOperationState(t.kit.ctx, upsert)).toBe('UPDATED');
    await run(
      t.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(t.kit.clock.now() - 1000).toISOString(), t.pass.id],
    );
    expect(await samsungOperationState(t.kit.ctx, upsert)).toBe('EXPIRED');
  });

  it('void and quarantine: CANCELED, kept on the instance; removal and deletion: DELETED', async () => {
    const t = await setupSamsungCallbacks();
    const revoke = asOperation(t, { kind: 'revoke' });
    await run(t.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [t.pass.id]);
    expect(await samsungOperationState(t.kit.ctx, revoke)).toBe('CANCELED');
    await run(t.kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      t.pass.id,
    ]);
    expect(await samsungOperationState(t.kit.ctx, revoke)).toBe('CANCELED');
    await run(t.kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      t.kit.clock.now(),
      t.pass.id,
    ]);
    expect(await samsungOperationState(t.kit.ctx, revoke)).toBe('DELETED');
  });

  it('transfer and channel-off retirement: DELETED', async () => {
    const t = await setupSamsungCallbacks();
    await run(t.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [t.pass.id]);
    // The pass moved on to a newer credential generation: this copy belongs to the old holder.
    expect(
      await samsungOperationState(
        t.kit.ctx,
        asOperation(t, {
          kind: 'revoke',
          credentialGeneration: t.operation.credentialGeneration - 1,
        }),
      ),
    ).toBe('DELETED');
    await run(
      t.kit.env.DB,
      'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?',
      [t.kit.clock.now(), t.operation.instanceId],
    );
    expect(await samsungOperationState(t.kit.ctx, asOperation(t, { kind: 'revoke' }))).toBe(
      'DELETED',
    );
  });

  it('unvoid: ACTIVE after a revoke the wallet was told about', async () => {
    const t = await setupSamsungCallbacks();
    const revoke = await settleRevoke(t);
    expect(
      await samsungOperationState(
        t.kit.ctx,
        asOperation(t, { kind: 'upsert', version: revoke.version + 1 }),
      ),
    ).toBe('ACTIVE');
  });
});

describe('6.1 both: a claim that went uncertain is settled by one sweeper', () => {
  it('returns a Samsung operation to retry once the old attempt cannot still be running', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const claim = {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      version: t.operation.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    // The fixture's first operation is pending: claim it, then lose the answer.
    expect(await claimWalletOperation(walletJobCtx(db), claim)).toBe('claimed');
    await markWalletClaimUncertain(walletJobCtx(db), { ...claim, now: t.kit.clock.now() });
    const state = () =>
      first<{ state: string }>(
        db,
        'SELECT state FROM wallet_provider_instance_operations WHERE instance_id = ? AND version = ?',
        [claim.instanceId, claim.version],
      );
    expect((await state())?.state).toBe('uncertain');
    // Inside the grace window nothing is touched.
    expect(await sweepUncertainOperations(jobCtxOf(t.kit), 10)).toBe(0);
    t.kit.clock.advance(11 * 60_000);
    expect(await sweepUncertainOperations(jobCtxOf(t.kit), 10)).toBe(1);
    expect((await state())?.state).toBe('retry');
  });
});

describe('6.1 both: expiry and upcoming events', () => {
  const event = (date: string) => ({ dateInformation: { date } });
  const pass = JSON.stringify({
    expirationDate: '2026-06-01T00:00:00Z',
    upcomingPassInformation: [event('2026-03-01T00:00:00Z'), event('2026-05-01T00:00:00Z')],
  });
  const at = (iso: string) => Date.parse(iso);

  // The calculation Apple's timed renders use (src/passkit/boundaries.ts): each start, each end (an
  // event without one runs the template's fallbackMinutes) and, for a wallet card, the expiry.
  const end = (iso: string) => at(iso) + 90 * 60_000 + 1;
  const options = { expiry: true, fallbackMinutes: 90 };

  it('lists the moments a card changes with no edit, in order', () => {
    expect(passBoundaries(pass, options)).toEqual([
      at('2026-03-01T00:00:00Z'),
      end('2026-03-01T00:00:00Z'),
      at('2026-05-01T00:00:00Z'),
      end('2026-05-01T00:00:00Z'),
      at('2026-06-01T00:00:00Z'),
    ]);
    expect(passBoundaries(null, options)).toEqual([]);
    expect(passBoundaries('not json', options)).toEqual([]);
  });

  it('counts the boundaries behind now, so crossing one is a new operation', () => {
    const boundaries = passBoundaries(pass, options);
    expect(boundaryPhase(boundaries, at('2026-02-01T00:00:00Z'))).toBe(0);
    expect(boundaryPhase(boundaries, at('2026-03-01T00:00:00Z'))).toBe(1);
    expect(boundaryPhase(boundaries, end('2026-03-01T00:00:00Z'))).toBe(2);
    expect(boundaryPhase(boundaries, at('2026-07-01T00:00:00Z'))).toBe(5);
    expect(nextBoundary(boundaries, at('2026-03-02T00:00:00Z'))).toBe(at('2026-05-01T00:00:00Z'));
    expect(nextBoundary(boundaries, at('2026-07-01T00:00:00Z'))).toBeNull();
  });
});

describe('Q5: provider updates and void visuals within 15 minutes at p95', () => {
  it('measures from the pass edit, so queueing and retries are inside it, and warns past the target', async () => {
    const t = await setupSamsungCallbacks();
    const info = vi.spyOn(t.kit.ctx.log, 'info');
    const warn = vi.spyOn(t.kit.ctx.log, 'warn');
    const op = { ...t.operation, createdAt: t.kit.clock.now() + 120_000 } as WalletOperation;
    t.kit.clock.advance(5 * 60_000);
    await recordSyncLag(t.kit.ctx, op);
    expect(info).toHaveBeenCalledWith(
      'wallet.sync_lag',
      expect.objectContaining({ code: 'WALLET_SYNC_LAG', lagMs: expect.any(Number) }),
    );
    // Queued two minutes after the edit and settled twenty minutes after it: the whole wait counts.
    t.kit.clock.advance(WALLET_UPDATE_TARGET_MS);
    await recordSyncLag(t.kit.ctx, op);
    expect(warn).toHaveBeenCalledWith(
      'wallet.sync_lag',
      expect.objectContaining({ code: 'WALLET_SYNC_LAG_OVER' }),
    );
  });
});
