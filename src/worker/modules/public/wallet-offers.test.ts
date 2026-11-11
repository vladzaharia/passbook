import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { WalletOffer } from '../../../shared/contracts/me.ts';
import type {
  GoogleWalletCredentials,
  SamsungWalletCredentials,
} from '../../../shared/contracts/wallet-providers.ts';
import { createApp } from '../../app.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { revokeWalletProviderAccount } from '../wallet-providers/account-service.ts';
import { setupWalletOfferKit } from '../wallet-providers/offers-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
interface OfferFixture {
  kit: Kit;
  pass: Pass;
  auth: SessionAuth;
  google: GoogleWalletCredentials;
  samsung: SamsungWalletCredentials;
}
let fixture: OfferFixture;
let app: OpenAPIHono<AppBindings>;
let holderEmail: string;
let headers: Record<string, string>;

beforeAll(async () => {
  // Real encrypted accounts are configured but cannot yet prove provider approval.
  fixture = await setupWalletOfferKit({ google: 'configured', samsung: 'configured' });
  const { kit, pass } = fixture;
  const holder = await makeUser(kit.fx);
  holderEmail = holder.primaryEmail;
  headers = (await makeSession(kit.fx, { userId: holder.id })).headers;
  const expected = await getHolderPass(kit.env.DB, pass.id, null);
  if (!expected) throw new Error('Missing holder transfer snapshot');
  const transferred = await startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    pass.id,
    { holderEmail, ownerUserId: holder.id },
    null,
    { kind: 'tenant-holder', expected },
  );
  expect(transferred.state).toBe('completed');
  const current = await getPass(kit.env.DB, pass.id);
  if (!current) throw new Error('Missing transferred pass');
  fixture.pass = current;
  app = createApp({
    stores: { ...fakeAuth(ORIGIN).stores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
}, 90_000);

const get = (path: string, requestHeaders: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers: requestHeaders }, fixture.kit.env);
const pathFor = (token: string, provider: 'google' | 'samsung') => `/p/${token}/wallet/${provider}`;

async function ownNewPass() {
  return fixture.kit.pass({ holderEmail });
}

async function holderOffers(passId: string) {
  const response = await get(`/api/v1/me/passes/${passId}`, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as { walletOffers: WalletOffer[]; inWallet: boolean };
}

describe('pending native wallets on holder surfaces', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'],
    [
      'iPhone in-app browser',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148',
    ],
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile'],
    ['Samsung', 'Mozilla/5.0 (Linux; Android 14; SM-S928B) SamsungBrowser/25.0 Mobile'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'],
  ])('keeps Apple available and withholds unverified providers on %s', async (_name, ua) => {
    const { pass, google, samsung } = fixture;
    const response = await get(`/p/${pass.downloadToken}`, { 'user-agent': ua });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="/p/${pass.downloadToken}/pass.pkpass"`);
    expect(html).not.toContain(pathFor(pass.downloadToken, 'google'));
    expect(html).not.toContain(pathFor(pass.downloadToken, 'samsung'));
    expect(html).toContain('alt="Add to Apple Wallet"');
    expect(html).not.toContain('alt="Add to Google Wallet"');
    expect(html).not.toContain('alt="Add to Samsung Wallet"');
    expect(html).not.toContain(google.privateKeyPem);
    expect(html).not.toContain(google.serviceAccountEmail);
    expect(html).not.toContain(samsung.partnerPrivateKeyPem);
    expect(html).not.toContain('BEGIN PRIVATE KEY');
    expect(html).not.toContain('pay.google.com/gp/v/save/');
  });

  it('returns no unverified native choices, independently of Apple registration', async () => {
    const { kit, pass, google, samsung } = fixture;
    expect((await get(`/api/v1/me/passes/${pass.id}`)).status).toBe(401);
    const listResponse = await get('/api/v1/me/passes', headers);
    expect(listResponse.status).toBe(200);
    const listText = await listResponse.text();
    const list = JSON.parse(listText) as { items: { id: string; walletOffers: WalletOffer[] }[] };
    const listOffers = list.items.find((item) => item.id === pass.id)?.walletOffers;
    expect(listOffers).toEqual([]);
    expect(listText).not.toContain(google.privateKeyPem);
    expect(listText).not.toContain(google.serviceAccountEmail);
    expect(listText).not.toContain(samsung.partnerPrivateKeyPem);
    expect(listText).not.toContain('BEGIN PRIVATE KEY');
    expect(listText).not.toContain('pay.google.com/gp/v/save/');

    const before = await holderOffers(pass.id);
    expect(before.inWallet).toBe(false);
    expect(before.walletOffers).toEqual([]);
    await kit.device(pass, 'holder-test-device', 'holder-test-push-token');
    const after = await holderOffers(pass.id);
    expect(after.inWallet).toBe(true);
    expect(after.walletOffers).toEqual([]);
  });

  it('rejects direct provider links without generating a bearer offer', async () => {
    const { kit, pass } = fixture;
    for (const provider of ['google', 'samsung'] as const) {
      const response = await get(pathFor(pass.downloadToken, provider));
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code: 'WALLET_PROVIDER_DISABLED' });
      expect(body).not.toContain('BEGIN PRIVATE KEY');
      expect(body).not.toContain('pay.google.com/gp/v/save/');
    }
    const offers = await first<{ n: number }>(
      kit.env.DB,
      `SELECT COUNT(*) AS n
      FROM wallet_provider_offer_refs r JOIN wallet_provider_instances i ON i.id = r.instance_id
      WHERE i.pass_id = ?`,
      [pass.id],
    );
    expect(offers?.n).toBe(0);
  });

  it.each(['voided', 'removed', 'expired'] as const)(
    'exposes no native choices on a %s pass',
    async (state) => {
      const pass = await ownNewPass();
      const db = fixture.kit.env.DB;
      if (state === 'voided')
        await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
      else if (state === 'removed')
        await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
          fixture.kit.clock.now(),
          pass.id,
        ]);
      else
        await run(
          db,
          'UPDATE pass_versions SET pass_json = json_set(pass_json, ?, ?) WHERE pass_id = ? AND version = ?',
          ['$.expirationDate', '2020-01-01T00:00:00Z', pass.id, pass.version],
        );
      const response = await get(`/p/${pass.downloadToken}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain(pathFor(pass.downloadToken, 'google'));
      expect(html).not.toContain(pathFor(pass.downloadToken, 'samsung'));
      expect((await holderOffers(pass.id)).walletOffers).toEqual([]);
    },
    120_000,
  );

  it('hides native choices for a soft-deleted pass', async () => {
    const pass = await ownNewPass();
    await run(fixture.kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
      fixture.kit.clock.now(),
      pass.id,
    ]);
    expect((await get(`/p/${pass.downloadToken}`)).status).toBe(404);
    expect((await holderOffers(pass.id)).walletOffers).toEqual([]);
  }, 120_000);

  it('does not expose a quarantined pass to either surface', async () => {
    const { kit } = fixture;
    const pass = await kit.pass({ mode: 'test', holderEmail });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect((await get(`/p/${pass.downloadToken}`)).status).toBe(404);
    expect((await get(`/api/v1/me/passes/${pass.id}`, headers)).status).toBe(404);
  }, 120_000);

  it('suppresses choices for a suspended organization', async () => {
    const { kit, pass } = fixture;
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      expect((await get(`/p/${pass.downloadToken}`)).status).toBe(404);
      expect((await holderOffers(pass.id)).walletOffers).toEqual([]);
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });

  it('keeps both choices unavailable after an account is revoked', async () => {
    const { kit, pass, auth } = fixture;
    await revokeWalletProviderAccount(kit.ctx, auth, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'google',
      expectedRevision: 1,
    });
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).not.toContain(pathFor(pass.downloadToken, 'google'));
    expect(html).not.toContain(pathFor(pass.downloadToken, 'samsung'));
    expect((await holderOffers(pass.id)).walletOffers).toEqual([]);
  });
});
