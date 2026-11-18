import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { putSamsungFetchRef } from './repo-callbacks.ts';
import { SAMSUNG_TOKEN_WINDOW_MS } from './samsung-limits.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

type Kit = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

const refState = (t: Kit) =>
  first<{ promoted_at: number | null; market_cc2: string | null; retired_at: number | null }>(
    t.kit.env.DB,
    'SELECT promoted_at, market_cc2, retired_at FROM wallet_samsung_fetch_refs WHERE id = ?',
    [t.referenceId],
  );
const instanceState = (t: Kit) =>
  first<{
    saved_at: number | null;
    holder_removed_at: number | null;
    lifecycle: string;
    installation_state: string;
  }>(
    t.kit.env.DB,
    `SELECT saved_at, holder_removed_at, lifecycle, installation_state FROM wallet_provider_instances
    WHERE id = ?`,
    [t.operation.instanceId],
  );
const receipts = (t: Kit) =>
  all<{ event: string | null; cc2: string | null; token_hash: string; request_id: string }>(
    t.kit.env.DB,
    `SELECT event, cc2, token_hash, request_id FROM wallet_samsung_callback_receipts
    WHERE instance_id = ? ORDER BY received_at, id`,
    [t.operation.instanceId],
  );
async function post(t: Kit, query: string, requestId?: string, token?: string) {
  const auth = token ?? (await t.token({ method: 'POST' }));
  const response = await t.call({
    method: 'POST',
    token: auth,
    query,
    body: '{}',
    ...(requestId ? { requestId } : {}),
  });
  return { auth, status: response.status };
}

describe('Samsung Send Card State events', () => {
  it('promotes the ref once on a verified ADDED, stores its market and marks the instance saved', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    const before = t.kit.clock.now();
    expect((await post(t, '?cc2=gb&event=ADDED')).status).toBe(200);
    const promoted = await refState(t);
    expect(promoted).toMatchObject({ market_cc2: 'GB', retired_at: null });
    expect(promoted?.promoted_at).toBeGreaterThanOrEqual(before);
    expect(await instanceState(t)).toMatchObject({
      saved_at: promoted?.promoted_at,
      holder_removed_at: null,
      lifecycle: 'active',
      installation_state: 'unknown',
    });
    expect(await receipts(t)).toEqual([
      expect.objectContaining({ event: 'ADDED', cc2: 'GB', request_id: 'fixture-request' }),
    ]);
    // The promoted ref now refreshes after the initial window has closed.
    t.kit.clock.advance(SAMSUNG_TOKEN_WINDOW_MS + 1);
    await t.renewEvidence();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    // A later ADDED neither re-promotes nor rewrites the market.
    expect((await post(t, '?cc2=us&event=ADDED', 'second-request')).status).toBe(200);
    expect(await refState(t)).toEqual(promoted);
    expect((await receipts(t)).map((r) => r.cc2)).toEqual(['GB', 'US']);
  });

  it('does not promote an ADDED that carries no market, and ignores unknown events', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await post(t, '?event=ADDED')).status).toBe(200);
    expect((await post(t, '?cc2=GB&event=SOMETHING_ELSE', 'r2')).status).toBe(200);
    expect((await post(t, '?cc2=GB&event=added', 'r3')).status).toBe(200);
    expect((await post(t, '?cc2=GB&event=ADDED&event=DELETED', 'r4')).status).toBe(200);
    expect((await refState(t))?.promoted_at).toBeNull();
    expect((await receipts(t)).map((r) => r.event).sort()).toEqual(['ADDED', null, null, null]);
  });

  it('records DELETED as the holder removing the card and nothing more', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    const promoted = await refState(t);
    t.kit.clock.advance(10);
    expect((await post(t, '?cc2=GB&event=DELETED', 'del')).status).toBe(200);
    const instance = await instanceState(t);
    expect(instance?.holder_removed_at).toBeGreaterThan(instance?.saved_at ?? Infinity);
    // No claim of erasure: the instance stays active, the ref stays promoted and unretired.
    expect(instance).toMatchObject({ lifecycle: 'active', installation_state: 'unknown' });
    expect(await refState(t)).toEqual(promoted);
    expect((await receipts(t)).map((r) => r.event)).toEqual(['ADDED', 'DELETED']);
  });

  it('records UPDATED and PROVISIONED without changing any state', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await post(t, '?cc2=GB&event=UPDATED')).status).toBe(200);
    expect((await post(t, '?cc2=GB&event=PROVISIONED', 'prov')).status).toBe(200);
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect(await instanceState(t)).toMatchObject({ saved_at: null, holder_removed_at: null });
    expect((await receipts(t)).map((r) => r.event)).toEqual(['UPDATED', 'PROVISIONED']);
  });

  it('treats the same token and x-request-id as one delivery, and any other reuse as replay', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const first = await post(t, '?cc2=GB&event=ADDED', 'delivery-1');
    expect(first.status).toBe(200);
    const promoted = await refState(t);
    t.kit.clock.advance(5);
    // Redelivery: answered like the first, nothing recorded or changed, even if the query differs.
    expect((await post(t, '?cc2=US&event=DELETED', 'delivery-1', first.auth)).status).toBe(200);
    expect((await post(t, '?cc2=GB&event=ADDED', 'delivery-1', first.auth)).status).toBe(200);
    expect(await receipts(t)).toHaveLength(1);
    expect(await refState(t)).toEqual(promoted);
    expect((await instanceState(t))?.holder_removed_at).toBeNull();
    // The same token under another request id is a replay.
    expect((await post(t, '?cc2=GB&event=ADDED', 'delivery-2', first.auth)).status).toBe(401);
    // A fresh token may reuse the request id: it is only a trace id.
    expect((await post(t, '?cc2=GB&event=UPDATED', 'delivery-1')).status).toBe(200);
    expect(await receipts(t)).toHaveLength(2);
    const hashes = (await receipts(t)).map((r) => r.token_hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('keeps the receipt, promotion and saved mark atomic when ADDED races another ADDED', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const [one, two] = [await t.token({ method: 'POST' }), await t.token({ method: 'POST' })];
    const [a, b] = await Promise.all([
      post(t, '?cc2=GB&event=ADDED', 'race-a', one),
      post(t, '?cc2=US&event=ADDED', 'race-b', two),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ref = await refState(t);
    // Exactly one promotion won; its own market is the one kept.
    expect(['GB', 'US']).toContain(ref?.market_cc2);
    expect(ref?.promoted_at).not.toBeNull();
    const recorded = await receipts(t);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((r) => r.event)).toEqual(['ADDED', 'ADDED']);
    expect((await instanceState(t))?.saved_at).toBe(ref?.promoted_at);
  });

  it('refuses promotion when the pass moved on, and promotion is write-once', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const stale = await t.token({ method: 'POST' });
    await run(t.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [t.pass.id]);
    expect((await post(t, '?cc2=GB&event=ADDED', 'stale', stale)).status).toBe(401);
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect(await receipts(t)).toEqual([]);
    expect((await instanceState(t))?.saved_at).toBeNull();

    const kit = await setupSamsungCallbacks({ promoted: false });
    expect((await post(kit, '?cc2=GB&event=ADDED')).status).toBe(200);
    for (const set of ['promoted_at = NULL', 'promoted_at = promoted_at + 1', "market_cc2 = 'US'"])
      await expect(
        run(kit.kit.env.DB, `UPDATE wallet_samsung_fetch_refs SET ${set} WHERE id = ?`, [
          kit.referenceId,
        ]),
      ).rejects.toThrow(/promotion is immutable/);
    expect((await refState(kit))?.market_cc2).toBe('GB');
  });

  it('accepts a signed path that is only the /cards suffix', async () => {
    const t = await setupSamsungCallbacks();
    const suffix = `/cards/${t.samsung.cardId}/${t.refId}`;
    expect((await t.call({ token: await t.token({ signedPath: suffix }) })).status).toBe(200);
    expect((await t.call({ token: await t.token({ signedPath: `/other${suffix}` }) })).status).toBe(
      401,
    );
  });
});

describe('Samsung gate', () => {
  it('stays closed: no receipt, promotion or ref while the provider is disabled', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const replays = () =>
      first(t.kit.env.DB, 'SELECT COUNT(*) AS n FROM wallet_samsung_auth_replays');
    const replaysBefore = await replays();
    const restore = setWalletProvidersEnabledForTest(false);
    try {
      const added = await post(t, '?cc2=GB&event=ADDED');
      expect(added.status).toBe(200);
      expect((await t.call({ token: await t.token() })).status).toBe(204);
    } finally {
      restore();
    }
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect(await receipts(t)).toEqual([]);
    expect(await instanceState(t)).toMatchObject({ saved_at: null, holder_removed_at: null });
    expect(await replays()).toEqual(replaysBefore);
    // New references stay unavailable at the policy gate and at the database.
    const scope = {
      orgId: t.kit.org.id,
      mode: 'live' as const,
      instanceId: t.operation.instanceId,
      operationVersion: t.operation.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const envelope = {
      kekVersion: 1,
      iv: new Uint8Array(12),
      wrappedDek: new Uint8Array(1),
      ciphertext: new Uint8Array(1),
    };
    const now = t.kit.clock.now();
    const input = {
      id: t.kit.ctx.ids.id(),
      hash: await sha256Hex(t.kit.ctx.ids.token(24)),
      envelope,
      now,
      expiresAt: now + 60_000,
    };
    expect(await whileDisabledForTest(putSamsungFetchRef, t.kit.env.DB, scope, input)).toBeNull();
    await expect(
      run(
        t.kit.env.DB,
        `INSERT INTO wallet_samsung_fetch_refs (id, ref_hash, instance_id, created_at, last_offered_at,
          initial_expires_at, kek_version, iv, wrapped_dek, ciphertext)
        VALUES (?, ?, ?, ?, ?, ?, 1, x'00', x'00', x'00')`,
        [input.id, input.hash, scope.instanceId, now, now, now + 60_000],
      ),
    ).rejects.toThrow(/provider reference is unavailable/);
  });
});
