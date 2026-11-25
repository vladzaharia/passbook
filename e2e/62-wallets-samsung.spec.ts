import { randomBytes } from 'node:crypto';
import { devices, expect, test } from '@playwright/test';
import { CompactSign, importPKCS8 } from 'jose';
import { createFixtureIdentity } from '../src/passkit/testing/fixture-identity.ts';
import { type Api, apiAs, BASE } from './helpers/api.ts';
import {
  MOCK,
  mockRequests,
  mockState,
  passPath,
  releaseProjection,
  requireE2eRelease,
  syncUntil,
  TEST,
  testPass,
  type WalletOrg,
  walletOrg,
} from './helpers/wallets.ts';

// CW12 (architecture.md section 7, product.md section 5): a Test pass with Samsung open against the mock
// wallets: the holder adds it, Samsung fetches the card and reports ADDED, and an edit reaches Samsung.
// Void and unvoid wait for CW11's Samsung lifecycle parity (cw12-plan.md). Needs playwright.wallets.config.ts.
test.describe.configure({ mode: 'serial' });

const GALAXY_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let admin: Api;
let w: WalletOrg;
let pass: Awaited<ReturnType<typeof testPass>>;
let samsungKey: string;
const partnerId = `e2e${randomBytes(4).toString('hex')}`;
const certificateId = randomBytes(2).toString('hex').toUpperCase();
const cardId = `card${randomBytes(6).toString('hex')}`;
let refId = '';
/** What the Day pass loses on a Samsung card (no thumbnail slot, no sharing); a reviewer approves exactly these. */
const SAMSUNG_OMISSIONS = ['image.thumbnail@thumbnail', 'sharing'];

/** A request Samsung signs with its own key (samsung-token-inbound.ts): the card fetch and the state callback. */
async function asSamsung(method: 'GET' | 'POST', query = ''): Promise<number> {
  const path = `/wallet/v1/samsung/cards/${cardId}/${refId}`;
  const token = await new CompactSign(
    new TextEncoder().encode(JSON.stringify({ API: { method, path } })),
  )
    .setProtectedHeader({
      alg: 'RS256',
      cty: 'AUTH',
      ver: '3',
      partnerId,
      certificateId,
      utc: Date.now(),
    })
    .sign(await importPKCS8(samsungKey, 'RS256'));
  const res = await fetch(`${BASE}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-request-id': randomBytes(8).toString('hex'),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  return res.status;
}

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  // The partner portal card: a loyalty card out of testing mode, as storeCard designs compile to.
  await fetch(`${MOCK}/__mock/samsung-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cardId, template: { cardType: 'loyalty', countryCode: 'US' } }),
  });
  const [partner, samsung] = await Promise.all([createFixtureIdentity(), createFixtureIdentity()]);
  samsungKey = samsung.privateKey;
  w = await walletOrg(admin, 'samsung', {
    provider: 'samsung',
    partnerId,
    certificateId,
    cardId,
    partnerPrivateKeyPem: partner.privateKey,
    partnerCertificatePem: partner.certificate,
    samsungCertificatePem: samsung.certificate,
  });
  await releaseProjection(admin, w, 'samsung', SAMSUNG_OMISSIONS);
  pass = await testPass(admin, w);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('a holder adds the pass to Samsung Wallet, and Samsung fetches it and reports it added', async ({
  browser,
}) => {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  const context = await browser.newContext({ ...pixel, userAgent: GALAXY_UA });
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    const badge = page.getByRole('link', { name: 'Add to Samsung Wallet' });
    await expect(badge).toHaveAttribute('href', `${pass.path}/wallet/samsung`);
  } finally {
    await context.close();
  }
  // The badge redirects to a one-time wrapper, which redirects to Samsung's Add to Wallet page (not followed).
  const hop = async (url: string) => {
    const res = await fetch(new URL(url, BASE), { redirect: 'manual' });
    expect(res.status).toBe(302);
    return res.headers.get('location') ?? '';
  };
  const wrapper = await hop(`${pass.path}/wallet/samsung`);
  expect(wrapper).toMatch(/^\/p\/wallet\/samsung\/[\w-]{43}$/);
  const target = new URL(await hop(wrapper));
  expect(`${target.origin}${target.pathname}`).toBe(
    `https://a.swallet.link/atw/v3/${certificateId}/${cardId}`,
  );
  refId = /pdata=([A-Za-z0-9_-]{1,32})/.exec(target.hash)?.[1] ?? '';
  expect(refId).not.toBe('');
  expect(await asSamsung('GET')).toBe(200);
  expect(await asSamsung('POST', '?event=ADDED&cc2=US')).toBe(200);
});

test('a field edit sends Samsung an update for the added card', async () => {
  const updates = async () =>
    (await mockRequests()).filter(
      (r) =>
        r.provider === 'samsung' &&
        r.method === 'POST' &&
        r.path === `/US/wltex/cards/${cardId}/updates` &&
        r.status === 200,
    );
  const before = (await updates()).length;
  await admin.send('PATCH', passPath(pass.id), { input: { message: 'Doors open at nine.' } }, TEST);
  await syncUntil(async () => (await updates()).length > before, 'Samsung got an update');
  expect((await mockState()).samsung.refs[refId]).toMatchObject({
    cardId,
    type: 'loyalty',
    state: 'UPDATED',
  });
});
