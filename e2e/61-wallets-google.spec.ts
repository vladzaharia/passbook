import { type Browser, devices, expect, test } from '@playwright/test';
import { type Api, apiAs } from './helpers/api.ts';
import {
  googleCredential,
  MOCK,
  mockRequests,
  mockState,
  passPath,
  releaseSystemGoogle,
  requireE2eRelease,
  syncUntil,
  TEST,
  testPass,
  type WalletOrg,
  walletOrg,
} from './helpers/wallets.ts';

// CW12 (architecture.md section 7, product.md section 5): a Test pass with Google open against the mock
// wallets. Needs playwright.wallets.config.ts (the e2e release); the main run ignores this file.
test.describe.configure({ mode: 'serial' });

type GoogleObject = {
  id: string;
  classId: string;
  state?: string;
  barcode?: unknown;
  messages?: { header?: string; body: string; messageType?: string }[];
} & Record<string, unknown>;

let admin: Api;
let w: WalletOrg;
let issuerId: string;
let pass: Awaited<ReturnType<typeof testPass>>;
/** The Day pass `message` field carries a change message (`%@`): an edit saved with `notify` announces it. */
const NEWS = 'Doors open at nine.';

/** This run's Google object: ids start with its own issuer id. */
async function object(): Promise<GoogleObject | undefined> {
  const objects = Object.values((await mockState()).google.genericObject ?? {}) as GoogleObject[];
  return objects.find((o) => o.id.startsWith(`${issuerId}.`));
}

const objectWrites = async (method: string) =>
  (await mockRequests()).filter(
    (r) =>
      r.provider === 'google' &&
      r.method === method &&
      r.status === 200 &&
      r.path.includes(`/genericObject/${issuerId}.`),
  );

async function holderPhone(browser: Browser) {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  const context = await browser.newContext(pixel);
  // Google's save page is never opened: the save link's JWT goes to the mock's instead, which records the save.
  await context.route(`**${pass.path}/wallet/google`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers().location ?? '';
    if (response.status() !== 302 || !location.startsWith('https://pay.google.com/gp/v/save/'))
      return route.fulfill({ response });
    return route.fulfill({
      status: 302,
      headers: { location: `${MOCK}${new URL(location).pathname}` },
    });
  });
  return context;
}

/** The holder page offers Google only while the pass is valid. */
async function expectBadge(browser: Browser, count: number) {
  const context = await holderPhone(browser);
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add to Google Wallet' })).toHaveCount(count);
  } finally {
    await context.close();
  }
}

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  const credential = googleCredential();
  issuerId = credential.issuerId;
  w = await walletOrg(admin, 'google', credential);
  // The Day pass thumbnail has no Google slot: the reviewer approves that omission, nothing else.
  expect(await releaseSystemGoogle(admin, w)).toEqual(['image.thumbnail@images.thumbnail']);
  pass = await testPass(admin, w);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('a holder saves the pass to Google Wallet', async ({ browser }) => {
  const context = await holderPhone(browser);
  try {
    const page = await context.newPage();
    await page.goto(pass.path);
    const badge = page.getByRole('link', { name: 'Add to Google Wallet' });
    await expect(badge).toHaveAttribute('href', `${pass.path}/wallet/google`);
    await badge.click();
    await expect(page.getByText('Saved to Google Wallet (mock).')).toBeVisible();
  } finally {
    await context.close();
  }
  const saved = await object();
  expect(saved?.classId.startsWith(`${issuerId}.`)).toBe(true);
  expect(saved?.state).toBe('ACTIVE');
  expect(saved?.barcode).toBeTruthy();
  const { saves } = (await mockState()).google;
  expect(saves.some((s) => s.objectIds.includes(saved?.id ?? ''))).toBe(true);
});

test('a field edit updates the object and sends its change message', async () => {
  const before = (await objectWrites('PATCH')).length;
  // `notify` keeps the field's changeMessage (passes/change-messages.ts): Apple's lock screen, Google's message.
  await admin.send('PATCH', passPath(pass.id), { input: { message: NEWS }, notify: true }, TEST);
  await syncUntil(
    async () => JSON.stringify(await object()).includes(NEWS),
    'the object has the new message field',
  );
  expect((await objectWrites('PATCH')).length).toBeGreaterThan(before);
  await syncUntil(
    async () => ((await object())?.messages ?? []).some((m) => m.body.includes(NEWS)),
    'the change message is on the object',
  );
  // One message per operation, and the first of the day notifies (google-messages.md).
  const sent = (await mockRequests()).filter(
    (r) => r.path.endsWith('/addMessage') && r.path.includes(issuerId),
  );
  expect(sent.map((r) => (r.body?.message as { messageType?: string })?.messageType)).toEqual([
    'TEXT_AND_NOTIFY',
  ]);
});

test('a void makes the object inactive without a barcode, and an unvoid restores it', async ({
  browser,
}) => {
  await admin.send('POST', `${passPath(pass.id)}/void`, undefined, TEST);
  await syncUntil(async () => (await object())?.state === 'INACTIVE', 'the object is inactive');
  const voided = await object();
  expect(voided?.barcode).toBeUndefined();
  expect(voided?.messages?.map((m) => m.body)).toEqual(['This pass is no longer valid.']);
  await expectBadge(browser, 0);

  await admin.send('POST', `${passPath(pass.id)}/unvoid`, undefined, TEST);
  await syncUntil(async () => (await object())?.state === 'ACTIVE', 'the object is active again');
  expect((await object())?.barcode).toBeTruthy();
  await expectBadge(browser, 1);
});
