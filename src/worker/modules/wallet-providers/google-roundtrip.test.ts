// WA5: a signed Google save callback reaches a new-model Test enrolment through the full POST, the
// receipt is the round trip Live needs, and another org's callback on that path is refused.
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { enableEnrolment } from './enrolment-service.ts';
import { googleCallbackUrl } from './google-callback-binding.ts';
import { clearGoogleCallbackKeyCache } from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';
import { googleObjectIds } from './google-ids.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import {
  setWalletProvidersEnabledForTest,
  walletProviderDisabledReason,
} from './provider-policy.ts';
import { testRoundTrip } from './repo-enrolments.ts';
import { googleCallbackRoutes } from './routes-google-callbacks.ts';
import {
  dropInsertGuards,
  enrol,
  platformSource,
  seedInstance,
  verificationOf,
} from './wallet-roundtrip-test-fixtures.ts';

let keys: CallbackSigningKeys;
beforeAll(async () => {
  vi.setConfig({ testTimeout: 120_000 });
  keys = await makeCallbackSigningKeys();
  setWalletProvidersEnabledForTest(true);
});
afterEach(() => vi.unstubAllGlobals());

const receipts = (orgId: string) =>
  all<{ account_id: string; mode: string; event_type: string }>(
    env.DB,
    'SELECT account_id, mode, event_type FROM wallet_google_callback_receipts WHERE org_id = ?',
    [orgId],
  );

describe('Google save callback for a new-model Test enrolment', () => {
  it('stores the receipt on the enrolment, which Live then accepts as its round trip', async () => {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'absent',
      holderEmail: 'h@example.test',
    });
    const { kit } = f;
    kit.clock.set(Date.now());
    await dropInsertGuards(env.DB);
    const orgId = kit.org.id;
    const testSource = await platformSource(f, 'test', '33880000000100001');
    const a = await enrol(f, orgId, 'test', testSource, true);
    expect(await walletProviderDisabledReason(env.DB, 'google', orgId, 'test')).toBeNull();
    const pass = await kit.pass({ mode: 'test', holderEmail: 'h@example.test' });
    const verification = await verificationOf(f, orgId, 'test', a);
    const seeded = await seedInstance(f, pass, a, verification);

    // Another org, same platform issuer, its own key: its callback on A's path is refused.
    const other = await makeOrg(kit.fx);
    const b = await enrol(f, other.id, 'test', testSource, true);
    const bVerification = await verificationOf(f, other.id, 'test', b);
    const foreign = await googleObjectIds(bVerification.issuerId, bVerification.objectIdHmacKey, {
      tenantId: other.id,
      mode: 'test',
      releaseId: 'release-b',
      passId: 'pass-b',
      credentialGeneration: 1,
    });

    const app = new Hono<AppBindings>();
    app.use('*', requestContext({ stores: denyAllStores, clock: kit.clock }));
    app.onError(handleError);
    app.route('/wallet/v1/google', googleCallbackRoutes);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, kit.clock.now() + 60_000)),
    );
    const post = async (
      accountId: string,
      ids: { classId: string; objectId: string },
      nonce: string,
    ) =>
      (
        await app.request(
          googleCallbackUrl(kit.ctx, accountId),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'Google-Valuables' },
            body: await signedGoogleEvent(
              keys,
              verification.issuerId,
              {
                ...ids,
                nonce,
                eventType: 'save',
                expTimeMillis: String(kit.clock.now() + 60_000),
                opaqueToken: 'secret-token-value',
              },
              { keyExpiration: kit.clock.now() + 60_000 },
            ),
          },
          kit.env,
        )
      ).status;

    expect(await post(a.accountId, foreign, 'nonce-foreign')).toBe(401);
    expect(await receipts(orgId)).toEqual([]);
    expect(await receipts(other.id)).toEqual([]);
    expect(await testRoundTrip(env.DB, orgId, 'google')).toBeNull();

    // Live cannot be enabled before the round trip.
    const liveSource = await platformSource(f, 'live', '33880000000100002');
    const live = await enrol(f, orgId, 'live', liveSource, false);
    await expect(
      enableEnrolment(kit.ctx, live.auth, orgId, 'google', { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'WALLET_ENROLMENT_PREREQUISITE' });

    // The receipt must postdate the enrolment's source event, which the database stamped.
    kit.clock.set(Date.now() + 2_000);
    expect(await post(a.accountId, seeded, 'nonce-own')).toBe(204);
    expect(await receipts(orgId)).toEqual([
      { account_id: a.accountId, mode: 'test', event_type: 'save' },
    ]);
    expect(await testRoundTrip(env.DB, orgId, 'google')).not.toBeNull();
    expect(await walletProviderDisabledReason(env.DB, 'google', orgId, 'live')).toBe(
      'not_enrolled',
    );
    const { addCheck } = await import('./repo-wallet-credentials-test-fixtures.ts');
    await addCheck(liveSource.id, liveSource.versionId);
    await enableEnrolment(kit.ctx, live.auth, orgId, 'google', { expectedRevision: 1 });
    expect(await walletProviderDisabledReason(env.DB, 'google', orgId, 'live')).toBeNull();
  });
});
