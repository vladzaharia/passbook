import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  revokeWalletProviderAccount,
} from './account-service.ts';
import {
  getSamsungRefreshTarget,
  inspectSamsungRefRetirement,
  retireExpiredUnpromotedRef,
} from './callbacks-ref.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstance,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  requestWalletRetirement,
  retireWalletInstance,
} from './instance.ts';
import { onWalletPassRetired } from './lifecycle.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { SAMSUNG_UNCONFIRMED_SERVE_MS } from './samsung-limits.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

type Kit = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

const refRow = (t: Kit) =>
  first<{ promoted_at: number | null; market_cc2: string | null; retired_at: number | null }>(
    t.kit.env.DB,
    'SELECT promoted_at, market_cc2, retired_at FROM wallet_samsung_fetch_refs WHERE id = ?',
    [t.referenceId],
  );
const receiptCount = async (t: Kit) =>
  (
    await first<{ n: number }>(
      t.kit.env.DB,
      'SELECT COUNT(*) AS n FROM wallet_samsung_callback_receipts WHERE instance_id = ?',
      [t.operation.instanceId],
    )
  )?.n;
const instanceMarks = (t: Kit) =>
  first<{ saved_at: number | null; holder_removed_at: number | null }>(
    t.kit.env.DB,
    'SELECT saved_at, holder_removed_at FROM wallet_provider_instances WHERE id = ?',
    [t.operation.instanceId],
  );
async function post(t: Kit, query: string, token?: string) {
  return (
    await t.call({
      method: 'POST',
      token: token ?? (await t.token({ method: 'POST' })),
      query,
      body: '{}',
    })
  ).status;
}

describe('a served ref nobody confirms', () => {
  it('stops blocking a revoke after the deadline, so the pass can be deleted', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const db = t.kit.env.DB;
    // Samsung previews the card (Get Card Data) and the holder cancels: no ADDED ever follows.
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const scope = {
      orgId: t.kit.org.id,
      mode: 'live' as const,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const instance = await getWalletInstance(db, {
      ...scope,
      provider: 'samsung',
      passId: t.pass.id,
    });
    const pass = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    if (!instance || !pass) throw new Error('Missing retirement fixture');
    expect(
      await requestWalletRetirement(db, {
        ...scope,
        provider: 'samsung',
        instanceId: instance.id,
        version: instance.desiredVersion,
        now: t.kit.clock.now(),
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        lifecycleGeneration: pass.lifecycleGeneration,
        issuingReleaseId: pass.issuingReleaseId,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    ).toBe(true);
    await onWalletPassRetired(jobCtxOf(t.kit), {
      orgId: scope.orgId,
      mode: scope.mode,
      passId: pass.passId,
      passVersion: pass.passVersion,
      passRevision: pass.passRevision,
      lifecycleGeneration: pass.lifecycleGeneration,
      passCredentialGeneration: pass.credentialGeneration,
    });
    const retiring = await getWalletInstance(db, {
      ...scope,
      provider: 'samsung',
      passId: t.pass.id,
    });
    if (!retiring) throw new Error('Missing revoke operation');
    const revoke = {
      ...scope,
      instanceId: retiring.id,
      operationVersion: retiring.desiredVersion,
    };
    // Within the wait it is not absent, and nothing can be notified yet.
    t.kit.clock.advance(SAMSUNG_UNCONFIRMED_SERVE_MS - 1_000);
    expect(await inspectSamsungRefRetirement(t.kit.ctx, revoke)).toBe('needs_notification');
    expect(await getSamsungRefreshTarget(t.kit.ctx, revoke)).toBeNull();
    // Past it the ref is served but unconfirmed. A compiled card names no market until ADDED reports one.
    t.kit.clock.advance(2_000);
    expect(await inspectSamsungRefRetirement(t.kit.ctx, revoke)).toBe('served_unconfirmed');
    const target = await getSamsungRefreshTarget(t.kit.ctx, revoke);
    expect(target?.refId).toBe(t.refId);
    expect(target?.countryCodes).toEqual([]);
    // With no market to notify it is closed under the revoke's lease and the revoke settles.
    const claim = {
      ...scope,
      provider: 'samsung' as const,
      instanceId: retiring.id,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(db), claim)).toBe('claimed');
    expect(
      await retireExpiredUnpromotedRef(t.kit.ctx, { ...revoke, claimHandle: claim.claimHandle }),
    ).toBe('no_external_card');
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), { ...claim, result: { kind: 'not_issued' } }),
    ).toBe('succeeded');
    expect(await persistSamsungTombstone(t.kit.ctx, revoke)).toBe(true);
    expect(await retireWalletInstance(db, { ...claim, now: t.kit.clock.now() })).toBe(true);
    // Later fetches are answered 204 through the tombstone, and erasure is no longer blocked.
    const later = await t.call({ token: await t.token() });
    expect(later.status).toBe(204);
    await run(db, 'DELETE FROM passes WHERE id = ?', [t.pass.id]);
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [retiring.id]),
    ).toBeNull();
  });

  it('cannot close a served ref inside the wait, even under the revoke lease', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const revoke = await queueWalletOperation(walletJobCtx(t.kit.env.DB), {
      ...t.operation,
      kind: 'revoke',
      expectedVersion: t.operation.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing revoke fixture');
    const scope = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      instanceId: revoke.instanceId,
      operationVersion: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    t.kit.clock.advance(SAMSUNG_UNCONFIRMED_SERVE_MS - 1_000);
    const claim = {
      ...scope,
      provider: 'samsung' as const,
      instanceId: revoke.instanceId,
      version: revoke.version,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(t.kit.env.DB), claim)).toBe('claimed');
    expect(
      await retireExpiredUnpromotedRef(t.kit.ctx, { ...scope, claimHandle: claim.claimHandle }),
    ).toBe('needs_notification');
    expect((await refRow(t))?.retired_at).toBeNull();
  });
});

describe('issued-ref callbacks and the credential they verified under', () => {
  const rotate = async (t: Kit, same: boolean) => {
    const scope = { orgId: t.kit.org.id, mode: 'live' as const, provider: 'samsung' as const };
    const account = await getWalletProviderReadiness(t.kit.ctx, scope);
    const identity = await createFixtureIdentity(undefined, {
      now: new Date(t.kit.clock.now()),
    });
    await configureWalletProviderAccount(t.kit.ctx, t.auth, {
      ...scope,
      expectedRevision: account.revision,
      credentials: same
        ? t.samsung
        : {
            ...t.samsung,
            partnerPrivateKeyPem: identity.privateKey,
            partnerCertificatePem: identity.certificate,
            samsungCertificatePem: identity.certificate,
          },
    });
    return scope;
  };
  const untouched = async (t: Kit) => {
    expect(await receiptCount(t)).toBe(0);
    expect(await refRow(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect(await instanceMarks(t)).toEqual({ saved_at: null, holder_removed_at: null });
  };

  it('lets a credential that equals the current one write, and an older one only answer', async () => {
    // Rotated to the same partner, certificate id and Samsung certificate: still the same issuer.
    const same = await setupSamsungCallbacks({ promoted: false });
    expect((await same.call({ token: await same.token() })).status).toBe(200);
    await rotate(same, true);
    expect(await post(same, '?cc2=GB&event=ADDED')).toBe(200);
    expect(await refRow(same)).toMatchObject({ market_cc2: 'GB' });
    expect(await receiptCount(same)).toBe(1);

    // Rotated to a different Samsung certificate: the old one still authenticates, writes nothing.
    const older = await setupSamsungCallbacks({ promoted: false });
    expect((await older.call({ token: await older.token() })).status).toBe(200);
    await rotate(older, false);
    expect(await post(older, '?cc2=GB&event=ADDED')).toBe(200);
    expect(await post(older, '?cc2=GB&event=DELETED')).toBe(200);
    await untouched(older);
    // The token was still spent: it cannot be replayed to write later.
    const spent = await older.token({ method: 'POST' });
    expect(await post(older, '?cc2=GB&event=ADDED', spent)).toBe(200);
    expect(await post(older, '?cc2=GB&event=ADDED', spent)).toBe(401);
    await untouched(older);
  });

  it('answers but changes nothing once the account is revoked', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const scope = { orgId: t.kit.org.id, mode: 'live' as const, provider: 'samsung' as const };
    // An account is revoked only after its instances retire; lift the lifecycle guards to reach
    // that state with the ref still unburied, as after a retirement that never wrote a tombstone.
    const guards = await all<{ name: string }>(
      t.kit.env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND tbl_name = 'wallet_provider_instances' AND sql LIKE '%UPDATE OF lifecycle%'`,
    );
    for (const { name } of guards) await run(t.kit.env.DB, `DROP TRIGGER ${name}`);
    await run(
      t.kit.env.DB,
      "UPDATE wallet_provider_instances SET lifecycle = 'retired' WHERE id = ?",
      [t.operation.instanceId],
    );
    const account = await getWalletProviderReadiness(t.kit.ctx, scope);
    await revokeWalletProviderAccount(t.kit.ctx, t.auth, {
      ...scope,
      expectedRevision: account.revision,
    });
    expect(await post(t, '?cc2=GB&event=ADDED')).toBe(200);
    expect(await post(t, '?cc2=GB&event=DELETED')).toBe(200);
    await untouched(t);
  });

  it('does no sealing before a token has verified, and never for a credential that cannot write', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    try {
      const forged = `${(await t.token({ method: 'POST' })).split('.').slice(0, 2).join('.')}.${'A'.repeat(342)}`;
      // Live path, then (after the window) the issued-ref path.
      expect(await post(t, '?cc2=GB&event=ADDED', forged)).toBe(401);
      t.kit.clock.advance(300_001);
      expect(await post(t, '?cc2=GB&event=ADDED', forged)).toBe(401);
      expect(encrypt).not.toHaveBeenCalled();
      expect(await post(t, '?cc2=GB&event=ADDED')).toBe(200);
      expect(encrypt).toHaveBeenCalledTimes(2);
    } finally {
      encrypt.mockRestore();
    }
  });

  it('records but never applies a callback on a retired ref', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    await run(t.kit.env.DB, 'UPDATE wallet_samsung_fetch_refs SET retired_at = ? WHERE id = ?', [
      t.kit.clock.now(),
      t.referenceId,
    ]);
    expect(await post(t, '?cc2=GB&event=ADDED')).toBe(200);
    expect(await post(t, '?cc2=GB&event=DELETED')).toBe(200);
    expect(await refRow(t)).toMatchObject({ promoted_at: null, market_cc2: null });
    expect(await instanceMarks(t)).toEqual({ saved_at: null, holder_removed_at: null });
    expect(
      await first<{ n: number }>(
        t.kit.env.DB,
        'SELECT COUNT(*) AS n FROM wallet_samsung_country_hints WHERE ref_id = ?',
        [t.referenceId],
      ),
    ).toEqual({ n: 0 });
  });
});
