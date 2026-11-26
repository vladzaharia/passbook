import { devices, expect, test } from '@playwright/test';
import { type Api, apiAs, BASE, uid } from './helpers/api.ts';
import {
  mockRequests,
  mockState,
  passPath,
  releaseSystem,
  requireE2eRelease,
  samplePass,
  syncUntil,
  TEST,
  type WalletOrg,
  walletOrg,
  withoutLookup,
} from './helpers/wallets.ts';
import { GALAXY_UA, samsungKit } from './helpers/wallets-phone.ts';

// CW12 (architecture.md section 7, product.md section 5): a Test pass with Samsung open against the mock
// wallets: the holder adds it, Samsung fetches the card and reports ADDED, and an edit, void, unvoid, transfer,
// deletion and expiry each reach Samsung as its state. Needs playwright.wallets.config.ts.
test.describe.configure({ mode: 'serial' });

const { defaultBrowserType: _pixel, ...PIXEL } = devices['Pixel 7'];

let admin: Api;
let w: WalletOrg;
let pass: Awaited<ReturnType<typeof samplePass>>;
let kit: Awaited<ReturnType<typeof samsungKit>>;
let refId = '';

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  // The partner portal card: a loyalty card out of testing mode, as storeCard designs compile to.
  kit = await samsungKit('loyalty');
  // Without its card number lookup the store card's scan code is rotated by a transfer (see withoutLookup).
  w = await walletOrg(admin, 'samsung', kit.credential, {
    blueprint: 'baked:starter-store-card',
    manifest: withoutLookup,
  });
  await releaseSystem(admin, w, 'samsung');
  pass = await samplePass(admin, w);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('a holder adds the pass to Samsung Wallet, and Samsung fetches it and reports it added', async ({
  browser,
}) => {
  const context = await browser.newContext({ ...PIXEL, userAgent: GALAXY_UA });
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    const badge = page.getByRole('link', { name: 'Add to Samsung Wallet' });
    await expect(badge).toHaveAttribute('href', `${pass.path}/wallet/samsung`);
  } finally {
    await context.close();
  }
  refId = await kit.add(pass.path);
});

test('a field edit sends Samsung an update for the added card', async () => {
  const updates = async () =>
    (await mockRequests()).filter(
      (r) =>
        r.provider === 'samsung' &&
        r.method === 'POST' &&
        r.path === `/US/wltex/cards/${kit.cardId}/updates` &&
        r.status === 200,
    );
  const before = (await updates()).length;
  await admin.send('PATCH', passPath(pass.id), { input: { note: 'Doors open at nine.' } }, TEST);
  await syncUntil(async () => (await updates()).length > before, 'Samsung got an update');
  expect((await mockState()).samsung.refs[refId]).toMatchObject({
    cardId: kit.cardId,
    type: 'loyalty',
    state: 'UPDATED',
  });
});

/** What Samsung was last sent for a ref (`/__mock/state`): its card state and type. */
const sent = async (ref: string) => (await mockState()).samsung.refs[ref];
const sentState = async (ref: string) => (await sent(ref))?.state;
const sentRefs = async () => Object.keys((await mockState()).samsung.refs);

test('a void sends Samsung CANCELED, and an unvoid sends it ACTIVE again', async () => {
  await admin.send('POST', `${passPath(pass.id)}/void`, undefined, TEST);
  await syncUntil(async () => (await sentState(refId)) === 'CANCELED', 'Samsung got CANCELED');
  await admin.send('POST', `${passPath(pass.id)}/unvoid`, undefined, TEST);
  await syncUntil(async () => (await sentState(refId)) === 'ACTIVE', 'Samsung got ACTIVE');
});

test('a transfer deletes the old ref and Samsung gets a new ref for the new holder', async () => {
  const oldRef = refId;
  await admin.send(
    'POST',
    '/api/v1/holders/reassign',
    { passId: pass.id, email: `${uid('next')}@example.test` },
    TEST,
  );
  await syncUntil(async () => (await sentState(oldRef)) === 'DELETED', 'the old ref is deleted');
  // The old ref no longer serves the card; the new holder's add makes a new one.
  expect(await kit.asSamsung(oldRef, 'GET')).not.toBe(200);
  // The transfer rotated the pass's link: the new holder adds from the new one, once the transfer has finished.
  let path = pass.path;
  await expect
    .poll(
      async () => {
        const detail = await admin.send<{ publicUrl: string }>(
          'GET',
          passPath(pass.id),
          undefined,
          TEST,
        );
        path = new URL(detail.publicUrl).pathname;
        return (await fetch(new URL(`${path}/wallet/samsung`, BASE), { redirect: 'manual' }))
          .status;
      },
      { message: 'the new link offers Samsung', timeout: 30_000 },
    )
    .toBe(302);
  const next = await kit.add(path);
  expect(next).not.toBe(oldRef);
  expect(await sentRefs()).toContain(oldRef);
  refId = next;
});

test('deleting the pass sends Samsung DELETED for its ref', async () => {
  await admin.send('DELETE', passPath(pass.id), undefined, TEST);
  await syncUntil(async () => (await sentState(refId)) === 'DELETED', 'Samsung got DELETED');
});

// DoD 8: one pass of each Samsung type, from the blueprint that makes it.
const TYPES = [
  { type: 'loyalty', blueprint: 'starter-store-card' },
  { type: 'ticket', blueprint: 'starter-event-ticket' },
  { type: 'coupon', blueprint: 'starter-coupon' },
] as const;

for (const t of TYPES) {
  test(`a ${t.type} pass is added as a Samsung ${t.type} card and an edit reaches it`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const samsung = await samsungKit(t.type);
    const typed = await walletOrg(admin, `s-${t.type}`, samsung.credential, {
      blueprint: `baked:${t.blueprint}`,
    });
    await releaseSystem(admin, typed, 'samsung');
    const holder = await samplePass(admin, typed);
    const context = await browser.newContext({ ...PIXEL, userAgent: GALAXY_UA });
    try {
      const page = await context.newPage();
      await page.goto(holder.path);
      await expect(page.getByRole('link', { name: 'Add to Samsung Wallet' })).toBeVisible();
    } finally {
      await context.close();
    }
    const ref = await samsung.add(holder.path);
    const served = await samsung.card(ref);
    expect(served.card.type).toBe(t.type);
    expect(served.card.data[0]).toMatchObject({ refId: ref, state: 'ACTIVE' });
    expect(Object.keys(served.card.data[0]?.attributes ?? {})).toContain('title');

    await admin.send('PATCH', passPath(holder.id), { input: { note: 'Edited note.' } }, TEST);
    await syncUntil(async () => (await sentState(ref)) === 'UPDATED', 'Samsung got the update');
    expect(await sent(ref)).toMatchObject({ type: t.type, cardId: samsung.cardId });
  });
}

test('an expired coupon is sent to Samsung as EXPIRED', async () => {
  test.setTimeout(120_000);
  const samsung = await samsungKit('coupon');
  const coupon = await walletOrg(admin, 's-expiry', samsung.credential, {
    blueprint: 'baked:starter-coupon',
  });
  await releaseSystem(admin, coupon, 'samsung');
  const holder = await samplePass(admin, coupon);
  const ref = await samsung.add(holder.path);
  await admin.send(
    'PATCH',
    passPath(holder.id),
    { input: { expirationDate: '2020-01-01T00:00:00Z' } },
    TEST,
  );
  await syncUntil(async () => (await sentState(ref)) === 'EXPIRED', 'Samsung got EXPIRED');
});
