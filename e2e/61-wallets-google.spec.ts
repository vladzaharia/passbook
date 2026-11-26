import { type Browser, devices, expect, test } from '@playwright/test';
import { type Api, apiAs, BASE, uid } from './helpers/api.ts';
import {
  googleCredential,
  MOCK,
  mockRequests,
  mockState,
  passPath,
  releaseSystemGoogle,
  requireE2eRelease,
  samplePass,
  syncUntil,
  TEST,
  testPass,
  type WalletOrg,
  walletOrg,
  withoutLookup,
} from './helpers/wallets.ts';
import { saveToGoogle } from './helpers/wallets-phone.ts';

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
  w = await walletOrg(admin, 'google', credential, { manifest: withoutLookup });
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

test('the fourth notifying change in a day reaches Google as text, with no notifying message', async () => {
  const notified = async () =>
    (await mockRequests())
      .filter((r) => r.path.endsWith('/addMessage') && r.path.includes(issuerId))
      .map((r) => (r.body?.message as { messageType?: string })?.messageType);
  const change = (text: string) =>
    admin.send('PATCH', passPath(pass.id), { input: { message: text }, notify: true }, TEST);
  // The first change above notified; two more fill Google's budget of three.
  for (const [i, text] of ['Doors open at ten.', 'Doors open at eleven.'].entries()) {
    await change(text);
    await syncUntil(async () => (await notified()).length === i + 2, `notifying message ${i + 2}`);
  }
  await change('Doors open at noon.');
  await syncUntil(
    async () => JSON.stringify(await object()).includes('Doors open at noon.'),
    'the fourth change is on the object',
  );
  // Over budget it rides the object as text: no fourth notifying call.
  expect(await notified()).toEqual(['TEXT_AND_NOTIFY', 'TEXT_AND_NOTIFY', 'TEXT_AND_NOTIFY']);
  const messages = ((await object())?.messages ?? []).map((m) => m.messageType);
  expect(messages.at(-1)).toBe('TEXT');
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

test('a transfer makes the old object inactive, and the new holder saves a new one', async ({
  browser,
}) => {
  const objects = async () =>
    (Object.values((await mockState()).google.genericObject ?? {}) as GoogleObject[]).filter((o) =>
      o.id.startsWith(`${issuerId}.`),
    );
  const [old] = await objects();
  await admin.send(
    'POST',
    '/api/v1/holders/reassign',
    { passId: pass.id, email: `${uid('next')}@example.test` },
    TEST,
  );
  await syncUntil(
    async () => (await objects()).find((o) => o.id === old?.id)?.state === 'INACTIVE',
    'the old object is inactive',
  );
  // The transfer rotated the pass's link; the new holder saves from the new one once the transfer has finished.
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
        return (await fetch(new URL(`${path}/wallet/google`, BASE), { redirect: 'manual' })).status;
      },
      { message: 'the new link offers Google', timeout: 30_000 },
    )
    .toBe(302);
  await saveToGoogle(browser, path);
  const after = await objects();
  expect(after).toHaveLength(2);
  expect(after.filter((o) => o.state === 'ACTIVE').map((o) => o.id)).not.toContain(old?.id);
  expect(after.filter((o) => o.state === 'ACTIVE')).toHaveLength(1);
});

test('removing the pass makes its object inactive, as a void does (Google cannot delete)', async () => {
  await admin.send('DELETE', passPath(pass.id), undefined, TEST);
  await syncUntil(
    async () =>
      (Object.values((await mockState()).google.genericObject ?? {}) as GoogleObject[])
        .filter((o) => o.id.startsWith(`${issuerId}.`))
        .every((o) => o.state === 'INACTIVE'),
    'every object of the pass is inactive',
  );
});

// DoD 8: one pass of each Google type, from the blueprint that makes it, saved on a Pixel.
type Collection =
  | 'genericObject'
  | 'loyaltyObject'
  | 'giftCardObject'
  | 'eventTicketObject'
  | 'offerObject';
type Doc = Record<string, unknown>;

/** A Balance card read as a gift card: no member ID, its card number from the input (Q14: a balance card). */
const asGiftCard = (m: { wallets: Record<string, unknown> }) => ({
  ...m,
  wallets: {
    ...m.wallets,
    roles: { memberId: false, giftCardNumber: { value: '{{cardNumber}}' } },
    google: { ...(m.wallets.google as object), type: 'gift' },
  },
});

const TYPES: {
  type: string;
  blueprint: string;
  object: Collection;
  klass: string;
  manifest?: typeof asGiftCard;
  /** What the object and its class say, from the blueprint's own sample. */
  says: (object: Doc, klass: Doc) => void;
}[] = [
  {
    type: 'Generic',
    blueprint: 'starter-generic',
    object: 'genericObject',
    klass: 'genericClass',
    says: (object) => expect(JSON.stringify(object.header)).toContain('Alex Morgan'),
  },
  {
    type: 'Loyalty',
    blueprint: 'starter-store-card',
    object: 'loyaltyObject',
    klass: 'loyaltyClass',
    says: (object, klass) => {
      expect(object.accountId).toBe('CARD-0001');
      expect(JSON.stringify(object.secondaryLoyaltyPoints)).toContain('25000000');
      expect(klass.programName).toBeTruthy();
    },
  },
  {
    type: 'Gift card',
    blueprint: 'starter-store-card',
    object: 'giftCardObject',
    klass: 'giftCardClass',
    manifest: asGiftCard,
    says: (object, klass) => {
      expect(object.cardNumber).toBe('CARD-0001');
      expect(object.balance).toEqual({ micros: '25000000', currencyCode: 'USD' });
      expect(klass.merchantName).toBeTruthy();
    },
  },
  {
    type: 'Event ticket',
    blueprint: 'starter-event-ticket',
    object: 'eventTicketObject',
    klass: 'eventTicketClass',
    says: (object, klass) => {
      expect(object.ticketHolderName).toBe('Alex Morgan');
      expect(JSON.stringify(klass.eventName)).toContain('Sample Event');
      expect(JSON.stringify(klass.venue)).toContain('Sample Hall');
    },
  },
  {
    type: 'Offer',
    blueprint: 'starter-coupon',
    object: 'offerObject',
    klass: 'offerClass',
    says: (object, klass) => {
      expect(klass.title).toBe('20% off');
      expect((object.barcode as Doc).type).toBe('PDF_417');
      expect(JSON.stringify(object.validTimeInterval)).toContain('2030-01-01T00:00:00Z');
    },
  },
];

for (const t of TYPES) {
  test(`the ${t.type} blueprint saves as a ${t.object} with its class`, async ({ browser }) => {
    test.setTimeout(120_000);
    const credential = googleCredential();
    const typed = await walletOrg(admin, `g-${t.object.toLowerCase()}`, credential, {
      blueprint: `baked:${t.blueprint}`,
      ...(t.manifest ? { manifest: t.manifest as never } : {}),
    });
    await releaseSystemGoogle(admin, typed);
    const holder = await samplePass(admin, typed);
    await saveToGoogle(browser, holder.path);

    const state = (await mockState()).google as unknown as Record<string, Record<string, Doc>>;
    const mine = (collection: string) =>
      Object.values(state[collection] ?? {}).filter((o) =>
        String(o.id).startsWith(`${credential.issuerId}.`),
      );
    const [object] = mine(t.object);
    const [klass] = mine(t.klass);
    expect(mine(t.object)).toHaveLength(1);
    expect(object?.state).toBe('ACTIVE');
    expect((object?.barcode as Doc | undefined)?.value).toBeTruthy();
    expect(object?.classId).toBe(klass?.id);
    t.says(object as Doc, klass as Doc);
    // No other type's object was made for this issuer.
    const others = (
      [
        'genericObject',
        'loyaltyObject',
        'giftCardObject',
        'eventTicketObject',
        'offerObject',
      ] as const
    )
      .filter((c) => c !== t.object)
      .flatMap(mine);
    expect(others).toEqual([]);
    const saves = (await mockState()).google.saves;
    expect(saves.some((save) => save.objectIds.includes(String(object?.id)))).toBe(true);
  });
}

test('an offer expiry edit reaches Google as the end of its validity interval', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const credential = googleCredential();
  const coupon = await walletOrg(admin, 'g-expiry', credential, {
    blueprint: 'baked:starter-coupon',
  });
  await releaseSystemGoogle(admin, coupon);
  const holder = await samplePass(admin, coupon);
  await saveToGoogle(browser, holder.path);
  const offer = async () =>
    (Object.values((await mockState()).google.offerObject ?? {}) as GoogleObject[]).find((o) =>
      o.id.startsWith(`${credential.issuerId}.`),
    );
  expect(JSON.stringify((await offer())?.validTimeInterval)).toContain('2030-01-01T00:00:00Z');
  await admin.send(
    'PATCH',
    passPath(holder.id),
    { input: { expirationDate: '2031-02-03T00:00:00Z' } },
    TEST,
  );
  await syncUntil(
    async () => JSON.stringify((await offer())?.validTimeInterval).includes('2031-02-03T00:00:00Z'),
    'the offer ends on the new date',
  );
});

test('an upcoming event that has ended rolls off the Google object with no edit', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const credential = googleCredential();
  const events = await walletOrg(admin, 'g-roll', credential, {
    blueprint: 'baked:starter-event-ticket',
  });
  await releaseSystemGoogle(admin, events);
  // With a local offset: a bare Z time is refused ("no local offset").
  const at = (ms: number) => new Date(Date.now() + ms).toISOString().replace('Z', '+00:00');
  const venue = { venueName: 'Sample Hall', venueRegion: 'Cupertino, CA' };
  const holder = await samplePass(admin, events, {
    venueTimeZone: 'UTC',
    startsAt: at(7_200_000),
    endsAt: at(10_800_000),
    doorsAt: at(7_000_000),
    upcomingEvents: [
      { name: 'Opening night', startsAt: at(4_000), endsAt: at(14_000), ...venue },
      { name: 'Closing night', startsAt: at(7_200_000), endsAt: at(10_800_000), ...venue },
    ],
  });
  await saveToGoogle(browser, holder.path);
  const upcoming = async () => {
    const [ticket] = (
      Object.values((await mockState()).google.eventTicketObject ?? {}) as GoogleObject[]
    ).filter((o) => o.id.startsWith(`${credential.issuerId}.`));
    return JSON.stringify(ticket?.textModulesData ?? []);
  };
  expect(await upcoming()).toContain('Opening night');
  // Nobody edits the pass: the first tap parked the instance until the next event boundary.
  await syncUntil(
    async () => !(await upcoming()).includes('Opening night'),
    'the first event rolls off',
  );
  expect(await upcoming()).toContain('Closing night');
});
