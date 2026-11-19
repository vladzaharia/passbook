// Two orgs on one issuer (or one partner) stay apart: a callback reaches an org only through ids its own
// enrolment derived, never through the shared identity.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { all } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import type { StoredCredentials } from './account-credential-material.ts';
import { applyEnrolmentSource } from './account-credential-source.ts';
import {
  cardMapOf,
  googleSecret,
  realCredential,
  samsungSecret,
} from './account-credential-test-fixtures.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { clearGoogleCallbackKeyCache } from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
} from './google-callback-test-kit.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { refused, seedOrg } from './repo-wallet-credentials-test-fixtures.ts';
import { enrolment, setSource } from './repo-wallet-enrolments-test-fixtures.ts';
import { type GoogleOrg, googleOrg } from './shared-issuer-isolation-fixtures.ts';

let keys: CallbackSigningKeys;
beforeAll(async () => {
  setWalletProvidersEnabledForTest(true);
  vi.setConfig({ testTimeout: 60_000 });
  keys = await makeCallbackSigningKeys();
});
beforeEach(() => clearGoogleCallbackKeyCache());
afterEach(() => vi.unstubAllGlobals());

const receipts = (o: GoogleOrg) =>
  all(o.kit.env.DB, 'SELECT id FROM wallet_google_callback_receipts WHERE account_id = ?', [
    o.account.id,
  ]);

/** A's event on B's path is refused and leaves nothing behind; each org's own path still accepts. */
async function expectIsolated(a: GoogleOrg, b: GoogleOrg): Promise<void> {
  vi.stubGlobal('fetch', async () =>
    Response.json(await callbackKeyset(keys.root, a.kit.clock.now() + 60_000)),
  );
  expect(a.issuerId).toBe(b.issuerId);
  expect(a.classId).not.toBe(b.classId);
  expect(a.objectId).not.toBe(b.objectId);
  expect(await b.post(b.callbackUrl, await a.event(keys))).toBe(401);
  expect(await a.post(a.callbackUrl, await b.event(keys))).toBe(401);
  expect(await receipts(a)).toEqual([]);
  expect(await receipts(b)).toEqual([]);
  expect(await a.post(a.callbackUrl, await a.event(keys))).toBe(204);
  expect(await b.post(b.callbackUrl, await b.event(keys))).toBe(204);
  expect(await receipts(a)).toHaveLength(1);
  expect(await receipts(b)).toHaveLength(1);
}

describe('Google on a shared issuer', () => {
  it('refuses A on B path with no receipt, and the ids differ', async () => {
    const db = env.DB;
    await expectIsolated(await googleOrg(db), await googleOrg(db));
  });

  it('holds with each org on its own credential of the same identity (one unverified)', async () => {
    const db = env.DB;
    const [a, b] = [await googleOrg(db), await googleOrg(db)];
    const secret = await googleSecret(a.issuerId);
    for (const o of [a, b]) {
      const c = await realCredential(o.kit.env, { orgId: o.orgId, provider: 'google' }, secret);
      await setSource({ id: o.account.id, orgId: o.orgId, mode: 'live', provider: 'google' }, c);
    }
    const rows = await all<{ identity_hash: string }>(
      db,
      'SELECT identity_hash FROM wallet_provider_accounts WHERE id IN (?, ?)',
      [a.account.id, b.account.id],
    );
    // The enrolments carry the same identity hash: it must never attribute a callback.
    expect(new Set(rows.map((r) => r.identity_hash)).size).toBe(1);
    await expectIsolated(a, b);
  });

  it('holds with both orgs on the one platform credential', async () => {
    const db = env.DB;
    const [a, b] = [await googleOrg(db), await googleOrg(db)];
    const platform = await realCredential(
      a.kit.env,
      { scope: 'platform', provider: 'google' },
      await googleSecret(a.issuerId),
    );
    for (const o of [a, b])
      await setSource(
        { id: o.account.id, orgId: o.orgId, mode: 'live', provider: 'google' },
        platform,
      );
    await expectIsolated(a, b);
  });
});

const ctx = () => createServiceContext(env);

describe('a credential pin', () => {
  it('resolves only a version of the platform or the enrolment own org, for its mode, provider and card', async () => {
    const [{ org: orgA }, { org: orgB }, { org: orgC }] = [
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
    ];
    const a = await enrolment(orgA.id, 'live', 'samsung');
    const owner = { id: a.id, orgId: a.orgId, mode: a.mode, provider: a.provider };
    const c = await enrolment(orgC.id, 'live', 'samsung');
    const ownerC = { id: c.id, orgId: c.orgId, mode: c.mode, provider: c.provider };
    const stored: StoredCredentials = {
      version: 1,
      provider: 'samsung',
      credentials: (await samsungSecret('legacy', 'legacy-card')).credentials as never,
    };
    const resolve = (versionId: string, who = owner) =>
      applyEnrolmentSource(ctx(), who, stored, { versionId });
    const create = async (
      o: Parameters<typeof realCredential>[1],
      partner: string,
      card: string,
      cardMapCard = card,
    ) =>
      (
        await realCredential(
          env,
          { provider: 'samsung', ...o },
          await samsungSecret(partner, card),
          await cardMapOf(cardMapCard),
        )
      ).currentId;
    const own = await create({ orgId: orgA.id }, 'partner-a', 'card-a');
    const platform = await create({ scope: 'platform' }, 'partner-p', 'card-p');
    const foreign = await create({ orgId: orgB.id }, 'partner-b', 'card-b');
    const otherMode = await create({ orgId: orgA.id, mode: 'test' }, 'partner-t', 'card-t');
    const wrongCard = await create({ orgId: orgC.id }, 'partner-w', 'card-w', 'card-b');

    expect(await resolve(own)).toMatchObject({ credentials: { cardId: 'card-a' } });
    expect(await resolve(platform)).toMatchObject({ credentials: { cardId: 'card-p' } });
    // B's version id, B's card in A's version, a Test credential for a Live enrolment: all unresolvable.
    await refused(resolve(foreign), /unavailable/i);
    await refused(resolve(otherMode), /unavailable/i);
    await refused(resolve(wrongCard, ownerC), /unavailable/i);
    await refused(resolve(crypto.randomUUID()), /unavailable/i);
  });
});

describe('Samsung on a shared partner', () => {
  it('refuses a ref presented with another card id', async () => {
    const t = await setupSamsungCallbacks();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const other = `/wallet/v1/samsung/cards/some-other-card/${t.refId}`;
    const refused = await t.call({ path: other, token: await t.token({ signedPath: other }) });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});
