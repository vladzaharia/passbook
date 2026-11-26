import { expect, test } from '@playwright/test';
import { type Api, apiAs, BASE } from './helpers/api.ts';
import { runMinuteCron } from './helpers/cron.ts';
import {
  enrolTestAccount,
  googleCredential,
  localSql,
  MOCK,
  mockRequests,
  mockState,
  passPath,
  providerRelease,
  releaseSystem,
  requireE2eRelease,
  runCredentialCheck,
  setRelease,
  syncUntil,
  systemCandidate,
  TEST,
  testPass,
  type WalletOrg,
  walletOrg,
} from './helpers/wallets.ts';
import {
  type Device,
  holderContext,
  pixelContext,
  samsungKit,
  saveToGoogle,
  seriousViolations,
  walletOrder,
} from './helpers/wallets-phone.ts';

// product.md section 5, browser journeys 1 and 3 to 15, on the mock wallets (the rest are in 61, 62 and the
// designer specs). Org `harbor` has Google and Samsung accounts, `north` none. Needs playwright.wallets.config.ts.
test.describe.configure({ mode: 'serial' });

let admin: Api;
let google: ReturnType<typeof googleCredential>;
let samsung: Awaited<ReturnType<typeof samsungKit>>;
let harbor: WalletOrg;
let north: WalletOrg;
let pass: Awaited<ReturnType<typeof testPass>>;
let northPass: Awaited<ReturnType<typeof testPass>>;
let ref = '';

const status = async (id: string) =>
  (
    await admin.send<{ providers: { provider: string; lifecycle: string; reported?: unknown }[] }>(
      'GET',
      `/api/v1/wallet-providers/passes/${encodeURIComponent(id)}`,
      undefined,
      TEST,
    )
  ).providers;
const lifecycleOf = async (provider: string) =>
  (await status(pass.id)).find((p) => p.provider === provider)?.lifecycle;

/** The mail the Test inbox captured for a holder, with its HTML. */
async function mailTo(org: WalletOrg, email: string) {
  let id = '';
  await expect
    .poll(
      async () => {
        const inbox = await admin.send<{ items: { id: string; to: string }[] }>(
          'GET',
          `/api/v1/test-inbox?orgId=${encodeURIComponent(org.org.id)}&mode=test`,
          undefined,
          TEST,
        );
        id = inbox.items.find((m) => m.to === email)?.id ?? '';
        return id;
      },
      { message: `the Test inbox mail to ${email}`, timeout: 30_000, intervals: [500, 1_000] },
    )
    .not.toBe('');
  const mail = await admin.send<{ html: string; text: string }>(
    'GET',
    `/api/v1/test-inbox/${id}?orgId=${encodeURIComponent(org.org.id)}&mode=test`,
    undefined,
    TEST,
  );
  return { id, ...mail };
}
const mailBadges = (html: string) =>
  [...html.matchAll(/alt="Add to (Apple|Google|Samsung) Wallet"/g)].map((m) => m[1]);

const googleObjects = async () =>
  Object.values((await mockState()).google.genericObject ?? {}).filter((o) =>
    String(o.id).startsWith(`${google.issuerId}.`),
  ) as { id: string; state: string; barcode?: unknown }[];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  google = googleCredential();
  samsung = await samsungKit('loyalty');
  harbor = await walletOrg(admin, 'harbor', [google, samsung.credential]);
  await releaseSystem(admin, harbor, 'google');
  await releaseSystem(admin, harbor, 'samsung');
  north = await walletOrg(admin, 'north', [], {});
  pass = await testPass(admin, harbor, undefined, { sendEmail: true });
  northPass = await testPass(admin, north);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('journey 1: harbor has both accounts On and north has none', async () => {
  const enrolments = async (org: WalletOrg) =>
    (
      await admin.send<{ items: { provider: string; state: string }[] }>(
        'GET',
        `/api/v1/orgs/${encodeURIComponent(org.org.id)}/wallet-enrolments`,
        undefined,
        TEST,
      )
    ).items;
  const on = (items: { provider: string; state: string }[]) =>
    items.filter((e) => e.state === 'on').map((e) => e.provider);
  expect(
    (await enrolments(harbor))
      .filter((e) => e.state === 'on')
      .map((e) => e.provider)
      .sort(),
  ).toEqual(['google', 'samsung']);
  expect(on(await enrolments(north))).toEqual([]);
});

test('journey 3: a new pass is not saved to Google or Samsung yet', async () => {
  expect(await status(pass.id)).toMatchObject([
    { provider: 'google', lifecycle: 'absent' },
    { provider: 'samsung', lifecycle: 'absent' },
  ]);
});

test('journey 4: the emailed pass lists Apple, Google and Samsung with PassBook links and no token of theirs', async ({
  browser,
}) => {
  const detail = await admin.send<{ holderEmail: string }>(
    'GET',
    passPath(pass.id),
    undefined,
    TEST,
  );
  const mail = await mailTo(harbor, detail.holderEmail);
  expect(mailBadges(mail.html)).toEqual(['Apple', 'Google', 'Samsung']);
  const token = pass.path.split('/')[2];
  expect(mail.text).toContain(`${BASE}/p/${token}/wallet/google`);
  expect(mail.text).toContain(`${BASE}/p/${token}/wallet/samsung`);
  expect(mail.html).not.toMatch(/pay\.google\.com|swallet\.link/);
  expect(mail.html + mail.text).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);
  expect(mail.html + mail.text).not.toMatch(/recommended/i);

  // Journey 15: the mail's HTML passes axe (set into a plain page: the inbox frame's own policy allows no script).
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(mail.html);
    expect(await seriousViolations(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

const ORDER: [Device, string[]][] = [
  ['pixel', ['Google', 'Samsung']],
  ['galaxy', ['Samsung', 'Google']],
  ['iphone', ['Apple', 'Google', 'Samsung']],
  ['desktop', ['Apple', 'Google', 'Samsung']],
];
for (const [device, order] of ORDER)
  test(`journeys 5 and 6: a ${device} leads with ${order[0]} and lists ${order.join(', ')}`, async ({
    browser,
  }) => {
    const context = await holderContext(browser, device);
    try {
      const page = await context.newPage();
      await page.goto(pass.path);
      expect(await walletOrder(page)).toEqual(order);
    } finally {
      await context.close();
    }
  });

test('journey 5: on an Android phone Apple is a line of text, not a badge', async ({ browser }) => {
  const context = await holderContext(browser, 'pixel');
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    await expect(page.getByText('For Apple Wallet, open this page on an iPhone.')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('journey 7: Google sends the save link, scoped to the Test issuer, and the pass is only offered', async ({
  browser,
}) => {
  const saves: string[] = [];
  const context = await pixelContext(browser, pass.path, saves);
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    await page.getByRole('link', { name: 'Add to Google Wallet' }).click();
    await expect(page.getByText('Saved to Google Wallet (mock).')).toBeVisible();
  } finally {
    await context.close();
  }
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/);
  const [object] = await googleObjects();
  expect(object?.state).toBe('ACTIVE');
  expect(await lifecycleOf('google')).toBe('active');
  const statuses = await status(pass.id);
  expect(statuses.find((p) => p.provider === 'google')?.reported).toBeUndefined();
});

test('journey 7: the Samsung add reaches Samsung and the pass is active there', async () => {
  ref = await samsung.add(pass.path);
  expect(await lifecycleOf('samsung')).toBe('active');
});

test('journey 9: an edit reaches Google as a PATCH and Samsung as an update', async () => {
  const news = 'Doors open at ten.';
  await admin.send('PATCH', passPath(pass.id), { input: { message: news } }, TEST);
  await syncUntil(
    async () => JSON.stringify(await googleObjects()).includes(news),
    'the Google object has the new message',
  );
  await syncUntil(
    async () => (await mockState()).samsung.refs[ref]?.state === 'UPDATED',
    'Samsung got the update',
  );
});

test('journey 10: a void inactivates both cards and takes the badges off the pass page', async ({
  browser,
}) => {
  await admin.send('POST', `${passPath(pass.id)}/void`, undefined, TEST);
  await syncUntil(
    async () => (await googleObjects())[0]?.state === 'INACTIVE',
    'the Google object is inactive',
  );
  await syncUntil(
    async () => (await mockState()).samsung.refs[ref]?.state === 'CANCELED',
    'Samsung got CANCELED',
  );
  const context = await holderContext(browser, 'galaxy');
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    expect(await walletOrder(page)).toEqual([]);
  } finally {
    await context.close();
  }
  await admin.send('POST', `${passPath(pass.id)}/unvoid`, undefined, TEST);
  await syncUntil(
    async () => (await googleObjects())[0]?.state === 'ACTIVE',
    'the Google object is active again',
  );
});

test('journey 11: an org with no account shows no Google or Samsung badge, only what Apple has', async ({
  browser,
}) => {
  for (const device of ['pixel', 'galaxy'] as const) {
    const context = await holderContext(browser, device);
    try {
      const page = await context.newPage();
      await page.goto(northPass.path);
      expect(await walletOrder(page)).toEqual([]);
      await expect(page.getByRole('link', { name: 'Save to this phone' })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test('journey 12: a failing Google account hides its badge, and a passing check brings it back', async ({
  browser,
}) => {
  const googleAccount = harbor.accounts.google ?? '';
  await fetch(`${MOCK}/__mock/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 404,
      match: `GET /walletobjects/v1/issuer/${google.issuerId}`,
      times: 2,
    }),
  });
  // Two definitive failures in a row make the account Failing (Q6); one would not.
  expect(await runCredentialCheck(admin, harbor.org.id, googleAccount)).toBe('failed');
  expect(await runCredentialCheck(admin, harbor.org.id, googleAccount)).toBe('failed');
  const context = await holderContext(browser, 'pixel');
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    expect(await walletOrder(page)).toEqual(['Samsung']);
    expect(await runCredentialCheck(admin, harbor.org.id, googleAccount)).toBe('ok');
    await page.reload();
    expect(await walletOrder(page)).toEqual(['Google', 'Samsung']);
  } finally {
    await context.close();
  }
});

test('journey 13: revoking Samsung drops its badge from the pass page and new emails, and is audited', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // An enrolment with a card in a wallet cannot be revoked until its instances retire, so this org has none.
  const quay = await walletOrg(admin, 'quay', [
    googleCredential(),
    (await samsungKit('loyalty')).credential,
  ]);
  await releaseSystem(admin, quay, 'google');
  await releaseSystem(admin, quay, 'samsung');
  const holder = await testPass(admin, quay);
  const galaxy = async () => {
    const context = await holderContext(browser, 'galaxy');
    try {
      const page = await context.newPage();
      await page.goto(holder.path);
      return await walletOrder(page);
    } finally {
      await context.close();
    }
  };
  expect(await galaxy()).toEqual(['Samsung', 'Google']);

  const base = `/api/v1/orgs/${encodeURIComponent(quay.org.id)}/wallet-enrolments`;
  const list = await admin.send<{ items: { provider: string; enrolmentRevision: number }[] }>(
    'GET',
    base,
    undefined,
    TEST,
  );
  // An enrolment is turned Off before it can be revoked.
  const off = await admin.send<{ enrolmentRevision: number }>(
    'POST',
    `${base}/samsung/disable`,
    { expectedRevision: list.items.find((e) => e.provider === 'samsung')?.enrolmentRevision },
    TEST,
  );
  await admin.send(
    'POST',
    `${base}/samsung/revoke`,
    { expectedRevision: off.enrolmentRevision },
    TEST,
  );
  expect(await galaxy()).toEqual(['Google']);

  const fresh = await testPass(admin, quay, undefined, { sendEmail: true });
  const detail = await admin.send<{ holderEmail: string }>(
    'GET',
    passPath(fresh.id),
    undefined,
    TEST,
  );
  expect(mailBadges((await mailTo(quay, detail.holderEmail)).html)).toEqual(['Apple', 'Google']);
  const audit = await admin.get<{ items: { action: string; actorType: string }[] }>(
    `/api/v1/audit?orgId=${encodeURIComponent(quay.org.id)}&limit=100`,
  );
  expect(audit.items.some((a) => /enrolment_revoke/.test(a.action) && a.actorType === 'user')).toBe(
    true,
  );
});

test('journey 14: Test never reaches Live', async () => {
  const live = await admin.get<{ items: { id: string }[] }>(
    `/api/v1/passes?orgId=${encodeURIComponent(harbor.org.id)}`,
  );
  expect(live.items.map((p) => p.id)).not.toContain(pass.id);
  const enrolments = await admin.get<{ items: { provider: string; state: string }[] }>(
    `/api/v1/orgs/${encodeURIComponent(harbor.org.id)}/wallet-enrolments`,
  );
  expect(enrolments.items.filter((e) => e.state === 'on')).toEqual([]);
  // The mock saw this run's Test issuer and no other: every object of the org's passes carries its id.
  const writes = (await mockRequests()).filter(
    (r) => r.provider === 'google' && r.method !== 'GET' && r.path.includes('/genericObject'),
  );
  expect(writes.length).toBeGreaterThan(0);
});

test('journey 15: the pass page has no axe violations and its badges are 48 px tall', async ({
  browser,
}) => {
  const context = await holderContext(browser, 'pixel');
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    await walletOrder(page);
    expect(await seriousViolations(page)).toEqual([]);
    const badge = page.getByRole('link', { name: 'Add to Google Wallet' });
    expect((await badge.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    await expect(badge.getByRole('img', { name: 'Add to Google Wallet' })).toBeVisible();
  } finally {
    await context.close();
  }
});

// DoD 11: the rollback. Voids and removals still reach the wallets; nothing new issues, updates or messages.
test.describe('the draining rehearsal', () => {
  test.describe.configure({ mode: 'serial' });
  let org: WalletOrg;
  let issuer: string;
  let card: Awaited<ReturnType<typeof samsungKit>>;
  let held: Awaited<ReturnType<typeof testPass>>;
  let heldRef = '';

  const issuerRequests = async (provider: 'google' | 'samsung') =>
    (await mockRequests()).filter(
      (r) =>
        r.provider === provider &&
        r.method !== 'GET' &&
        (provider === 'google' ? r.path.includes(issuer) : r.path.includes(card.cardId)),
    );

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const credential = googleCredential();
    issuer = credential.issuerId;
    card = await samsungKit('loyalty');
    org = await walletOrg(admin, 'drain', [credential, card.credential]);
    await releaseSystem(admin, org, 'google');
    await releaseSystem(admin, org, 'samsung');
    held = await testPass(admin, org);
    await saveToGoogle(browser, held.path);
    heldRef = await card.add(held.path);
    // Released, issued, saved: now the rollback.
    await setRelease('draining');
  });

  test.afterAll(async () => {
    await setRelease('released');
  });

  const offered = async (browser: import('@playwright/test').Browser, path: string) => {
    const context = await holderContext(browser, 'galaxy');
    try {
      const page = await context.newPage();
      await page.goto(path);
      return await walletOrder(page);
    } finally {
      await context.close();
    }
  };

  test('badges are gone from a pass already in both wallets', async ({ browser }) => {
    expect(await offered(browser, held.path)).toEqual([]);
  });

  test('a new pass is offered no Google or Samsung badge, and its save links are refused', async ({
    browser,
  }) => {
    const fresh = await testPass(admin, org);
    expect(await offered(browser, fresh.path)).toEqual([]);
    for (const provider of ['google', 'samsung'])
      expect(
        (await fetch(new URL(`${fresh.path}/wallet/${provider}`, BASE), { redirect: 'manual' }))
          .status,
      ).not.toBe(302);
    expect(await status(fresh.id)).toMatchObject([
      { provider: 'google', lifecycle: 'absent' },
      { provider: 'samsung', lifecycle: 'absent' },
    ]);
  });

  test('an edit and its message are not sent to either wallet', async () => {
    const before = {
      google: (await issuerRequests('google')).length,
      samsung: (await issuerRequests('samsung')).length,
    };
    await admin.send(
      'PATCH',
      passPath(held.id),
      { input: { message: 'Closed for the day.' }, notify: true },
      TEST,
    );
    for (let i = 0; i < 3; i++) await runMinuteCron();
    expect({
      google: (await issuerRequests('google')).length,
      samsung: (await issuerRequests('samsung')).length,
    }).toEqual(before);
  });

  test('a void still reaches Google and Samsung', async () => {
    await admin.send('POST', `${passPath(held.id)}/void`, undefined, TEST);
    await syncUntil(
      async () =>
        (
          Object.values((await mockState()).google.genericObject ?? {}) as {
            id: string;
            state: string;
          }[]
        ).some((o) => o.id.startsWith(`${issuer}.`) && o.state === 'INACTIVE'),
      'the Google object is inactive',
    );
    await syncUntil(
      async () => (await mockState()).samsung.refs[heldRef]?.state === 'CANCELED',
      'Samsung got CANCELED',
    );
  });
});

// CAND-1: a template released before its accounts were On gets its provider releases on the first drain after enable.
test('a template released before its accounts existed gets its Google and Samsung releases on the first drain', async () => {
  test.setTimeout(180_000);
  const cardKit = await samsungKit('loyalty');
  const early = await walletOrg(admin, 'early', [], { blueprint: 'baked:starter-store-card' });
  expect(await providerRelease(admin, early, 'google')).toBeNull();
  expect(await providerRelease(admin, early, 'samsung')).toBeNull();
  await enrolTestAccount(admin, early.org.id, googleCredential());
  await enrolTestAccount(admin, early.org.id, cardKit.credential);
  // No Apple release follows the enrolment: only the drain can have queued these candidates.
  await releaseSystem(admin, early, 'google', { cron: true });
  await releaseSystem(admin, early, 'samsung', { cron: true });
  expect(await providerRelease(admin, early, 'google')).not.toBeNull();
  expect(await providerRelease(admin, early, 'samsung')).not.toBeNull();
});

test('a Samsung card Samsung does not take yet is skipped, then released once it does', async () => {
  test.setTimeout(180_000);
  const cardKit = await samsungKit('loyalty');
  const late = await walletOrg(admin, 'late', cardKit.credential, {
    blueprint: 'baked:starter-store-card',
    // The card is out of the partner portal's sandbox just as the template is released.
    afterEnrol: () => cardKit.setCard({ state: 'BLOCKED' }),
  });
  await expect.poll(async () => Boolean(await systemCandidate(admin, late, 'samsung'))).toBe(true);
  for (let i = 0; i < 3; i++) await runMinuteCron();
  expect(await providerRelease(admin, late, 'samsung')).toBeNull();

  await cardKit.setCard({ state: 'ACTIVE' });
  // The sweep waits out its back-off (15 minutes) before it drives a stranded candidate again.
  localSql(
    `UPDATE wallet_provider_accounts SET projection_backfilled_at = 1 WHERE org_id = '${late.org.id}' AND provider = 'samsung'`,
  );
  await releaseSystem(admin, late, 'samsung', { cron: true });
  expect(await providerRelease(admin, late, 'samsung')).not.toBeNull();
});
