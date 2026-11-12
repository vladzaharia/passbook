import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, first } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createLogger } from '../../platform/log.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { GOOGLE_CALLBACK_KEYS_URL } from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';
import { issueWalletOffer, listWalletOffers, redeemSamsungOffer } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import {
  assertWalletProviderEnabled,
  setWalletProvidersEnabledForTest,
  WalletProviderDisabledError,
  walletProviderDisabledReason,
  walletProviderEnabledSql,
} from './provider-policy.ts';
import { providerRetirementPending } from './repo-sync-retention.ts';
import { samsungCallbackRoutes } from './routes-callbacks.ts';
import { googleCallbackRoutes } from './routes-google-callbacks.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';
import { refreshSamsungProjectionEvidence } from './samsung-verification.ts';
import { drainWalletProviderSync } from './sync.ts';

const testEnv = installKeysetTestEnv();
let keys: CallbackSigningKeys;
beforeAll(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  keys = await makeCallbackSigningKeys();
});
afterEach(() => vi.unstubAllGlobals());

const disabled = { status: 403, code: 'WALLET_PROVIDER_DISABLED' };

async function kitFor(options: Parameters<typeof setupWalletOfferKit>[0] = {}) {
  return setupWalletOfferKit({ ...options, db: (await testEnv()).DB });
}

async function expectNoProviderState(db: D1Database) {
  for (const table of [
    'wallet_provider_instances',
    'wallet_provider_offer_refs',
    'wallet_samsung_fetch_refs',
    'wallet_google_callback_bindings',
    'wallet_google_callback_receipts',
    'wallet_google_callback_replays',
    'wallet_samsung_callback_receipts',
    'wallet_samsung_auth_replays',
  ])
    expect(await all(db, `SELECT 1 FROM ${table}`), table).toEqual([]);
}

describe('wallet provider policy', () => {
  it('disables both providers with one typed reason, in code and in SQL', () => {
    for (const provider of ['google', 'samsung'] as const) {
      expect(walletProviderDisabledReason(provider)).toBe('not_released');
      expect(() => assertWalletProviderEnabled(provider)).toThrow(WalletProviderDisabledError);
    }
    expect(walletProviderEnabledSql('i.provider')).toBe('1 = 0');
    expect(() => walletProviderEnabledSql('provider; DROP TABLE x')).toThrow();
  });

  it('opens and restores through the test seam only', () => {
    const restore = setWalletProvidersEnabledForTest(true);
    expect(walletProviderDisabledReason('google')).toBeNull();
    expect(walletProviderEnabledSql('i.provider')).toBe("i.provider IN ('google', 'samsung')");
    restore();
    expect(walletProviderDisabledReason('samsung')).toBe('not_released');
  });
});

describe('disabled providers', () => {
  it('keeps account setup and credential storage working', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'configured' });
    for (const provider of ['google', 'samsung'] as const)
      expect(
        await getWalletProviderReadiness(f.kit.ctx, {
          orgId: f.pass.orgId,
          mode: 'live',
          provider,
        }),
      ).toMatchObject({ state: 'configured', externalApprovalVerified: false });
  });

  it('answers offers and save links with a stable 403 and no provider call or state', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'published' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = f.kit.ctx;
    expect(await listWalletOffers(ctx, f.pass.id)).toEqual([]);
    for (const provider of ['google', 'samsung'] as const)
      await expect(issueWalletOffer(ctx, f.pass.downloadToken, provider)).rejects.toMatchObject(
        disabled,
      );
    await expect(redeemSamsungOffer(ctx, 'a'.repeat(43))).rejects.toMatchObject(disabled);

    f.kit.env.RL_PUBLIC = fakeLimiter(10) as unknown as RateLimit;
    const app = createApp({ clock: f.kit.clock });
    for (const path of [
      `/p/${f.pass.downloadToken}/wallet/google`,
      `/p/${f.pass.downloadToken}/wallet/samsung`,
      `/p/wallet/samsung/${'a'.repeat(43)}`,
    ]) {
      const response = await app.request(`https://passbook.mobile${path}`, {}, f.kit.env);
      expect(response.status, path).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.json()).toMatchObject({ code: 'WALLET_PROVIDER_DISABLED' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNoProviderState(f.kit.env.DB);
  });

  it('refuses Samsung evidence probing without calling Samsung', async () => {
    const f = await kitFor({ google: 'absent', samsung: 'published' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const candidate = await first<{ id: string; candidate_hash: string }>(
      f.kit.env.DB,
      "SELECT id, candidate_hash FROM template_candidates WHERE provider = 'samsung' LIMIT 1",
    );
    await expect(
      refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, {
        orgId: f.pass.orgId,
        mode: 'live',
        candidateId: candidate?.id ?? '',
        candidateHash: candidate?.candidate_hash ?? '',
      }),
    ).rejects.toMatchObject(disabled);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs that the sync cron skips provider calls and leaves nothing uncertain', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'absent' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const info = vi.fn();
    const warn = vi.fn();
    const ctx = { ...f.kit.ctx, log: { ...f.kit.ctx.log, info, warn } };
    await drainWalletProviderSync(ctx);
    expect(info).toHaveBeenCalledWith(
      'wallet.sync_provider_calls_skipped',
      expect.objectContaining({ code: 'WALLET_PROVIDER_DISABLED' }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await all(
        f.kit.env.DB,
        "SELECT 1 FROM wallet_provider_instance_operations WHERE state = 'uncertain'",
      ),
    ).toEqual([]);
  });

  it('verifies and acknowledges a Google callback without recording anything', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'absent' });
    const account = await first<{ id: string }>(
      f.kit.env.DB,
      "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
      [f.pass.orgId],
    );
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json(await callbackKeyset(keys.root, f.kit.clock.now() + 60_000));
    });
    const logs: string[] = [];
    const app = new Hono<AppBindings>();
    app.use(
      '*',
      requestContext({
        stores: denyAllStores,
        clock: f.kit.clock,
        logger: (base) => createLogger(base, { sink: (line) => logs.push(line) }),
      }),
    );
    app.onError(handleError);
    app.route('/wallet/v1/google', googleCallbackRoutes);
    const issuer = f.google.issuerId;
    const body = await signedGoogleEvent(
      keys,
      issuer,
      {
        classId: `${issuer}.c_${'a'.repeat(43)}`,
        objectId: `${issuer}.o_${'b'.repeat(43)}`,
        nonce: 'nonce-1',
        eventType: 'save',
        expTimeMillis: String(f.kit.clock.now() + 60_000),
      },
      { keyExpiration: f.kit.clock.now() + 60_000 },
    );
    const send = (value: string) =>
      app.request(
        `https://passbook.mobile/wallet/v1/google/${account?.id}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: value },
        f.kit.env,
      );
    expect((await send(body)).status).toBe(204);
    expect(logs.join('\n')).toContain('wallet.callback_ignored');
    // A forged signature is still refused: the acknowledgement follows verification.
    const forged = await signedGoogleEvent(
      keys,
      issuer,
      JSON.parse(JSON.parse(body).signedMessage),
      { keyExpiration: f.kit.clock.now() + 60_000, messageSigner: keys.root },
    );
    expect((await send(forged)).status).toBe(401);
    expect(new Set(requested)).toEqual(new Set([GOOGLE_CALLBACK_KEYS_URL]));
    await expectNoProviderState(f.kit.env.DB);
  });

  it('acknowledges Samsung callbacks with a constant answer and no state', async () => {
    const f = await kitFor({ google: 'absent', samsung: 'published' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logs: string[] = [];
    const app = new Hono<AppBindings>();
    app.use(
      '*',
      requestContext({
        stores: denyAllStores,
        clock: f.kit.clock,
        logger: (base) => createLogger(base, { sink: (line) => logs.push(line) }),
      }),
    );
    app.onError(handleError);
    app.route('/wallet/v1/samsung', samsungCallbackRoutes);
    const url = `https://passbook.mobile/wallet/v1/samsung/cards/membership/${'r'.repeat(32)}`;
    expect((await app.request(url, {}, f.kit.env)).status).toBe(204);
    expect((await app.request(url, { method: 'POST', body: '{}' }, f.kit.env)).status).toBe(200);
    expect(logs.join('\n')).toContain('wallet.callback_ignored');
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNoProviderState(f.kit.env.DB);
  });

  it('leaves no provider state that could block pass retirement', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'published' });
    const db = f.kit.env.DB;
    const commitment = await requireCredentialRefKeyset(db, f.kit.env);
    // Nothing can create an instance while disabled, so the retirement predicate has nothing to wait on.
    await expect(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'google')).rejects.toMatchObject(
      disabled,
    );
    expect(await providerRetirementPending(db, f.pass.id, commitment)).toBe(false);
  });

  it('defers a due provider operation without claiming it or calling the provider', async () => {
    const f = await kitFor({ google: 'configured', samsung: 'absent' });
    const db = f.kit.env.DB;
    const commitment = await requireCredentialRefKeyset(db, f.kit.env);
    const account = await first<{ id: string }>(
      db,
      "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND provider = 'google'",
      [f.pass.orgId],
    );
    const releaseId = await historicalGoogleRelease(f);
    const operationId = f.kit.ctx.ids.id();
    await seedHistoricalProviderInstance(db, {
      id: f.kit.ctx.ids.id(),
      passId: f.pass.id,
      orgId: f.pass.orgId,
      mode: 'live',
      provider: 'google',
      credentialGeneration: 1,
      credentialKeysetCommitment: commitment,
      accountId: account?.id ?? '',
      releaseId,
      operationId,
      now: f.kit.clock.now(),
      upsert: { requestHash: await sha256Hex(operationId), state: 'pending' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    f.kit.clock.advance(1);
    await drainWalletProviderSync(f.kit.ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await first(
        db,
        'SELECT state, attempts FROM wallet_provider_instance_operations WHERE id = ?',
        [operationId],
      ),
    ).toEqual({ state: 'pending', attempts: 0 });
  });
});
