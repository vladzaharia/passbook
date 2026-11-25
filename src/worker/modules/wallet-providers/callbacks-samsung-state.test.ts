import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { sha256Base64Url, sha256Hex } from '../../platform/ids.ts';
import { getSamsungRefreshTarget } from './callbacks-ref.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { findSamsungPromotedRefreshAccount } from './repo-accounts.ts';
import { listSamsungCountryHints, putSamsungFetchRef } from './repo-callbacks.ts';
import { inspectSamsungRetirement } from './repo-callbacks-retirement.ts';
import { SAMSUNG_CLOCK_SKEW_MS, SAMSUNG_TOKEN_WINDOW_MS } from './samsung-limits.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

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
const servedAt = async (t: Kit) =>
  (
    await first<{ served_at: number | null }>(
      t.kit.env.DB,
      'SELECT served_at FROM wallet_samsung_fetch_refs WHERE id = ?',
      [t.referenceId],
    )
  )?.served_at;
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
  all<{
    event: string | null;
    cc2: string | null;
    query_bound: number;
    token_hash: string;
    request_id: string;
  }>(
    t.kit.env.DB,
    `SELECT event, cc2, query_bound, token_hash, request_id FROM wallet_samsung_callback_receipts
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
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    // A later ADDED neither re-promotes nor rewrites the market.
    expect((await post(t, '?cc2=us&event=ADDED', 'second-request')).status).toBe(200);
    expect(await refState(t)).toEqual(promoted);
    expect((await receipts(t)).map((r) => r.cc2)).toEqual(['GB', 'US']);
  });

  it('does not promote an ADDED that carries no market, and ignores unknown events', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const warn = vi.spyOn(t.kit.ctx.log, 'warn');
    expect((await post(t, '?event=ADDED')).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      'wallet.callback_state',
      expect.objectContaining({ code: 'WALLET_SAMSUNG_NO_MARKET', provider: 'samsung' }),
    );
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

  it('treats a token already recorded for the ref as one delivery, whatever its request id', async () => {
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
    // Another request id (a retry) is still that delivery: answered, nothing recorded or changed.
    expect((await post(t, '?cc2=GB&event=DELETED', 'delivery-2', first.auth)).status).toBe(200);
    expect(await receipts(t)).toHaveLength(1);
    expect((await instanceState(t))?.holder_removed_at).toBeNull();
    // A fresh token may reuse the request id: it is only a trace id.
    expect((await post(t, '?cc2=GB&event=UPDATED', 'delivery-1')).status).toBe(200);
    expect(await receipts(t)).toHaveLength(2);
    const hashes = (await receipts(t)).map((r) => r.token_hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('keeps the first committed market: a later ADDED never overwrites it', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await post(t, '?cc2=GB&event=ADDED', 'first')).status).toBe(200);
    const winner = await refState(t);
    t.kit.clock.advance(1_000);
    expect((await post(t, '?cc2=US&event=ADDED', 'second')).status).toBe(200);
    expect(await refState(t)).toEqual(winner);
    expect(winner).toMatchObject({ market_cc2: 'GB' });
    expect((await receipts(t)).map((r) => r.cc2)).toEqual(['GB', 'US']);
    expect((await instanceState(t))?.saved_at).toBeGreaterThan(winner?.promoted_at ?? Infinity);
  });

  it('keeps the receipt, promotion and saved mark atomic when two ADDED race', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const [one, two] = [await t.token({ method: 'POST' }), await t.token({ method: 'POST' })];
    const [a, b] = await Promise.all([
      post(t, '?cc2=GB&event=ADDED', 'race-a', one),
      post(t, '?cc2=US&event=ADDED', 'race-b', two),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ref = await refState(t);
    // The first receipt committed is the one whose market was kept.
    const committed = await all<{ cc2: string; received_at: number }>(
      t.kit.env.DB,
      'SELECT cc2, received_at FROM wallet_samsung_callback_receipts WHERE instance_id = ? ORDER BY rowid',
      [t.operation.instanceId],
    );
    expect(committed).toHaveLength(2);
    expect(ref?.market_cc2).toBe(committed[0]?.cc2);
    expect(ref?.promoted_at).toBe(committed[0]?.received_at);
    expect((await instanceState(t))?.saved_at).toBe(ref?.promoted_at);
  });

  it('records but never promotes an unserved ref once its live fences are gone', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    await run(t.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [t.pass.id]);
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect((await receipts(t)).map((r) => r.event)).toEqual(['ADDED']);
  });

  it('refuses every rewrite of promotion, market and first serve at the database', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const update = (set: string) =>
      run(t.kit.env.DB, `UPDATE wallet_samsung_fetch_refs SET ${set} WHERE id = ?`, [
        t.referenceId,
      ]);
    const now = t.kit.clock.now();
    // Unpromoted: a market alone, or a promotion without one, is refused.
    await expect(update("market_cc2 = 'GB'")).rejects.toThrow(/promotion is immutable/);
    await expect(update(`promoted_at = ${now}`)).rejects.toThrow(/promotion is immutable/);
    await expect(update('served_at = served_at + 1')).rejects.toThrow(/promotion is immutable/);
    await expect(update('market_query_bound = 1')).rejects.toThrow(/promotion is immutable/);
    await update(`promoted_at = ${now}, market_cc2 = 'GB', market_query_bound = 0`);
    for (const set of [
      'promoted_at = NULL',
      'promoted_at = promoted_at + 1',
      "market_cc2 = 'US'",
      'market_cc2 = NULL',
      'market_query_bound = 1',
    ])
      await expect(update(set)).rejects.toThrow(/promotion is immutable/);
    // A retired ref is never promoted.
    const gone = await setupSamsungCallbacks({ promoted: false });
    await run(gone.kit.env.DB, 'UPDATE wallet_samsung_fetch_refs SET retired_at = ? WHERE id = ?', [
      gone.kit.clock.now(),
      gone.referenceId,
    ]);
    await expect(
      run(
        gone.kit.env.DB,
        `UPDATE wallet_samsung_fetch_refs SET promoted_at = ?, market_cc2 = 'GB', market_query_bound = 0
        WHERE id = ?`,
        [gone.kit.clock.now(), gone.referenceId],
      ),
    ).rejects.toThrow(/promotion is immutable/);
    // Nor is a ref promoted and retired in one statement.
    const both = await setupSamsungCallbacks({ promoted: false });
    await expect(
      run(
        both.kit.env.DB,
        `UPDATE wallet_samsung_fetch_refs
        SET promoted_at = ?, market_cc2 = 'GB', market_query_bound = 0, retired_at = ? WHERE id = ?`,
        [both.kit.clock.now(), both.kit.clock.now(), both.referenceId],
      ),
    ).rejects.toThrow(/promotion is immutable/);
  });

  it('stores whether the signature covered the query that carried the market (L3)', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const query = '?cc2=GB&event=ADDED';
    const bound = await t.token({ method: 'POST', signedPath: `${t.path}${query}` });
    expect((await post(t, query, 'bound', bound)).status).toBe(200);
    expect((await receipts(t)).map((r) => r.query_bound)).toEqual([1]);
    expect(
      (
        await first<{ market_query_bound: number }>(
          t.kit.env.DB,
          'SELECT market_query_bound FROM wallet_samsung_fetch_refs WHERE id = ?',
          [t.referenceId],
        )
      )?.market_query_bound,
    ).toBe(1);
    const u = await setupSamsungCallbacks({ promoted: false });
    expect((await post(u, query)).status).toBe(200);
    expect((await receipts(u)).map((r) => r.query_bound)).toEqual([0]);
    expect(
      (
        await first<{ market_query_bound: number }>(
          u.kit.env.DB,
          'SELECT market_query_bound FROM wallet_samsung_fetch_refs WHERE id = ?',
          [u.referenceId],
        )
      )?.market_query_bound,
    ).toBe(0);
  });

  it('routes notifications by the ADDED market, with the hints only as a fallback (L4)', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect((await post(t, '?cc2=GB&event=UPDATED')).status).toBe(200);
    // No market yet: the unsigned hint is all there is.
    expect(await listSamsungCountryHints(t.kit.env.DB, t.referenceId)).toEqual(['GB']);
    expect((await post(t, '?cc2=GB&event=ADDED', 'added')).status).toBe(200);
    expect((await post(t, '?cc2=US&event=DELETED', 'removed')).status).toBe(200);
    const hints = await all<{ country_code: string }>(
      t.kit.env.DB,
      'SELECT country_code FROM wallet_samsung_country_hints WHERE ref_id = ? ORDER BY country_code',
      [t.referenceId],
    );
    expect(hints.map((h) => h.country_code)).toEqual(['GB', 'US']);
    expect(await listSamsungCountryHints(t.kit.env.DB, t.referenceId)).toEqual(['GB']);
    // A promoted fixture ref has hints and no market: the hints still route.
    const old = await setupSamsungCallbacks();
    expect((await post(old, '?cc2=FR&event=UPDATED')).status).toBe(200);
    expect(await listSamsungCountryHints(old.kit.env.DB, old.referenceId)).toEqual(['FR']);
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

describe('Samsung refs that served card data', () => {
  const serve = async (t: Kit) => {
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    expect(await servedAt(t)).not.toBeNull();
  };
  const queue = (t: Kit, kind: 'upsert' | 'revoke', expectedVersion: number) =>
    queueWalletOperation(walletJobCtx(t.kit.env.DB), {
      ...t.operation,
      kind,
      expectedVersion,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
  const closeWindow = async (t: Kit) => {
    t.kit.clock.advance(SAMSUNG_TOKEN_WINDOW_MS + 1);
  };

  it('records served_at on the first admitted fetch only', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    expect(await servedAt(t)).toBeNull();
    await serve(t);
    const first = await servedAt(t);
    t.kit.clock.advance(1_000);
    await serve(t);
    expect(await servedAt(t)).toBe(first);
    // A fetch that was refused serves nothing.
    const u = await setupSamsungCallbacks({ promoted: false });
    expect((await u.call({ token: 'not.a.token' })).status).toBe(401);
    expect(await servedAt(u)).toBeNull();
  });

  it('promotes a verified ADDED after the initial window', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    await serve(t);
    await closeWindow(t);
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    expect(await refState(t)).toMatchObject({ market_cc2: 'GB', retired_at: null });
    expect((await refState(t))?.promoted_at).not.toBeNull();
    expect((await instanceState(t))?.saved_at).not.toBeNull();
  });

  it('promotes a verified ADDED after the operation version moved on', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    await serve(t);
    expect(await queue(t, 'upsert', t.operation.version)).not.toBeNull();
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    expect(await refState(t)).toMatchObject({ market_cc2: 'GB' });
  });

  it('does not treat a served ref as absent at revoke, and still routes its DELETED', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    await serve(t);
    const revoke = await queue(t, 'revoke', t.operation.version);
    if (!revoke) throw new Error('Missing revoke fixture');
    const scope = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      instanceId: revoke.instanceId,
      operationVersion: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    await closeWindow(t);
    expect(await inspectSamsungRetirement(t.kit.env.DB, scope, t.kit.clock.now())).toBe(
      'needs_notification',
    );
    // Nothing to notify until the ADDED that carries its market arrives, even while the revoke waits.
    expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toBeNull();
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toEqual({
      refId: t.refId,
      countryCodes: ['GB'],
    });
    // The same revoke on a ref that never served card data has nothing to notify.
    const u = await setupSamsungCallbacks({ promoted: false });
    const gone = await queue(u, 'revoke', u.operation.version);
    if (!gone) throw new Error('Missing revoke fixture');
    await closeWindow(u);
    expect(
      await inspectSamsungRetirement(
        u.kit.env.DB,
        {
          orgId: gone.orgId,
          mode: gone.mode,
          instanceId: gone.instanceId,
          operationVersion: gone.version,
        },
        u.kit.clock.now(),
      ),
    ).toBe('no_external_card');
  });
});

describe('Samsung requests on issued refs outside their live fences', () => {
  it('answers authentic ones, and only authentic ones, with 204 and 200', async () => {
    const t = await setupSamsungCallbacks();
    const revoke = await queueWalletOperation(walletJobCtx(t.kit.env.DB), {
      ...t.operation,
      kind: 'revoke',
      expectedVersion: t.operation.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    expect(revoke).not.toBeNull();
    const get = await t.call({ token: await t.token() });
    expect(get.status).toBe(204);
    expect(await get.text()).toBe('');
    expect((await post(t, '?cc2=GB&event=DELETED')).status).toBe(200);
    expect((await receipts(t)).map((r) => r.event)).toEqual(['DELETED']);
    expect((await instanceState(t))?.holder_removed_at).not.toBeNull();
    // Forged, tampered and misdirected requests stay 401.
    const valid = await t.token();
    const tampered = `${valid.slice(0, valid.lastIndexOf('.') + 1)}${'A'.repeat(342)}`;
    expect((await t.call({ token: tampered })).status).toBe(401);
    expect((await t.call({ token: await t.token({ partnerId: 'other' }) })).status).toBe(401);
    expect((await t.call({ token: await t.token({ signedPath: `${t.path}x` }) })).status).toBe(401);
    expect((await t.call()).status).toBe(401);
    const unknown = `/wallet/v1/samsung/cards/${t.samsung.cardId}/${'z'.repeat(32)}`;
    expect(
      (await t.call({ path: unknown, token: await t.token({ signedPath: unknown }) })).status,
    ).toBe(401);
    // A replayed GET token is a replay, not an answer.
    const once = await t.token();
    expect((await t.call({ token: once })).status).toBe(204);
    expect((await t.call({ token: once })).status).toBe(401);
  });
});

describe('Samsung credential reads', () => {
  it('lets only an inbound callback use the initial window', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const db = t.kit.env.DB;
    const proof = {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      accountId: t.operation.accountId,
      accountRevision: t.operation.accountRevision,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      projectionReleaseId: t.operation.projectionReleaseId,
      instanceId: t.operation.instanceId,
      refHash: await sha256Hex(t.refId),
      operationVersion: t.operation.version,
    };
    const now = t.kit.clock.now();
    expect(await findSamsungPromotedRefreshAccount(db, proof, now)).toBeNull();
    expect(
      await findSamsungPromotedRefreshAccount(db, { ...proof, window: false }, now),
    ).toBeNull();
    expect(
      await findSamsungPromotedRefreshAccount(db, { ...proof, window: true }, now),
    ).not.toBeNull();
    // Once promoted, sync may use it too.
    expect((await post(t, '?cc2=GB&event=ADDED')).status).toBe(200);
    expect(await findSamsungPromotedRefreshAccount(db, proof, t.kit.clock.now())).not.toBeNull();
  });
});

describe('Samsung token window', () => {
  it('keeps the replay row to the end of the window and purges it after', async () => {
    const t = await setupSamsungCallbacks();
    const utc = t.kit.clock.now() + 1;
    const old = await t.token({ utc });
    expect((await t.call({ token: old })).status).toBe(200);
    const key = await sha256Base64Url(old);
    const expires = () =>
      first<{ expires_at: number }>(
        t.kit.env.DB,
        'SELECT expires_at FROM wallet_samsung_auth_replays WHERE token_hash = ?',
        [key],
      );
    expect((await expires())?.expires_at).toBe(
      utc + SAMSUNG_TOKEN_WINDOW_MS + SAMSUNG_CLOCK_SKEW_MS,
    );
    // Still inside the window, the token is a replay.
    t.kit.clock.advance(SAMSUNG_TOKEN_WINDOW_MS - 1);
    expect((await t.call({ token: old })).status).toBe(401);
    // Past the end of the replay window the next admitted request purges it.
    t.kit.clock.advance(SAMSUNG_CLOCK_SKEW_MS + 2);
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    expect(await expires()).toBeNull();
  });
});

describe('Samsung gate', () => {
  it('stays closed: no receipt, promotion or ref while the provider is disabled', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const replays = () =>
      first(t.kit.env.DB, 'SELECT COUNT(*) AS n FROM wallet_samsung_auth_replays');
    const replaysBefore = await replays();
    const get = await t.token();
    const added = await t.token({ method: 'POST' });
    const prepare = vi.spyOn(t.kit.env.DB, 'prepare');
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const restore = setWalletProvidersEnabledForTest(false);
    try {
      const response = await t.call({
        method: 'POST',
        token: added,
        query: '?cc2=GB&event=ADDED',
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect((await t.call({ token: get })).status).toBe(204);
    } finally {
      restore();
    }
    // Nothing was read or opened: no keyset, ref, receipt, credential or signature work.
    const sql = prepare.mock.calls.map(([text]) => String(text));
    expect(sql.filter((text) => /wallet_|credential_ref_keyset/.test(text))).toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    prepare.mockRestore();
    decrypt.mockRestore();
    verify.mockRestore();
    expect(await refState(t)).toEqual({ promoted_at: null, market_cc2: null, retired_at: null });
    expect(await servedAt(t)).toBeNull();
    expect(await receipts(t)).toEqual([]);
    expect(await instanceState(t)).toMatchObject({ saved_at: null, holder_removed_at: null });
    expect(await replays()).toEqual(replaysBefore);
    // New references and offers stay unavailable at the policy gate and at the database.
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
    await expect(
      run(
        t.kit.env.DB,
        `INSERT INTO wallet_provider_offer_refs (ref_hash, instance_id, operation_version, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`,
        [await sha256Hex('offer'), scope.instanceId, scope.operationVersion, now, now + 60_000],
      ),
    ).rejects.toThrow(/provider offer is unavailable/);
    await expect(
      run(
        t.kit.env.DB,
        'UPDATE wallet_provider_offer_refs SET delivered_at = delivered_at + 1 WHERE instance_id = ?',
        [scope.instanceId],
      ),
    ).rejects.toThrow(/provider offer is unavailable/);
  });
});
