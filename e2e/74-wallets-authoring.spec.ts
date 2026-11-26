import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, devices, expect, type Page, test } from '@playwright/test';
import { createFixtureIdentity } from '../src/passkit/testing/fixture-identity.ts';
import { type Api, apiAs, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { logoPng } from './helpers/png.ts';
import { publishTemplateVersion, templateReviewer } from './helpers/releases.ts';
import { shots } from './helpers/shots.ts';
import {
  enrolledOrg,
  googleCredential,
  MOCK,
  requireE2eRelease,
  syncUntil,
  TEST,
  testPass,
} from './helpers/wallets.ts';

// E2E-A: the authoring journey for cross-wallet templates, from the designer to the holder's badges.
// Needs playwright.wallets.config.ts (the e2e release); the main run ignores this file.
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/** The Store card blueprint's own Google logo, big enough for both wallets' rules. */
const ART = {
  name: 'logo.png',
  mimeType: 'image/png',
  buffer: readFileSync('templates/starter-store-card/wallets/google/logo.png'),
};

const png = (width: number, height: number) => ({
  name: 'art.png',
  mimeType: 'image/png',
  buffer: logoPng(width, height, [20, 90, 200]),
});

let admin: Api;
let org: { id: string; name: string };
let templateId = '';
let firstPass = '';
let importUrl = '';
const name = `Authoring ${uid('a')}`;

const design = (query = '') =>
  `/admin/o/${encodeURIComponent(org.id)}/templates/${encodeURIComponent(templateId)}/design${query}`;
const path = () => `/api/v1/templates/${encodeURIComponent(templateId)}`;
async function latestVersion() {
  const detail = await admin.get<{ versions: { version: string }[] }>(`${path()}?orgId=${org.id}`);
  return detail.versions[0]?.version ?? '';
}
async function active(provider: 'google' | 'samsung') {
  const { active } = await admin.send<{ active: { version: string } | null }>(
    'GET',
    `${path()}/releases?${new URLSearchParams({ orgId: org.id, mode: 'test', provider })}`,
    undefined,
    TEST,
  );
  return active;
}
async function systemCandidates(provider: 'google' | 'samsung') {
  const { items } = await admin.send<{ items: { version: string; authorId: string }[] }>(
    'GET',
    `${path()}/candidates?${new URLSearchParams({ orgId: org.id, mode: 'test', provider })}`,
    undefined,
    TEST,
  );
  return items.filter((c) => c.authorId.startsWith('system:'));
}
const rail = (page: Page) => page.getByRole('radiogroup', { name: 'Wallet' });
/** Opens an inspector section; one that is already open (the choice carries across wallets) stays. */
async function open(page: Page, name: RegExp) {
  const button = page.getByRole('button', { name });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}
const report = (page: Page, wallet: 'Google' | 'Samsung') =>
  page.getByRole('region', { name: `${wallet} Wallet report` });

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  const [partner, samsung] = await Promise.all([createFixtureIdentity(), createFixtureIdentity()]);
  const cardId = `card${uid('c').replace(/\W/g, '')}`;
  await fetch(`${MOCK}/__mock/samsung-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cardId, template: { cardType: 'loyalty', countryCode: 'US' } }),
  });
  org = await enrolledOrg(admin, 'authoring', [
    googleCredential(),
    {
      provider: 'samsung',
      partnerId: `e2e${uid('p').replace(/\W/g, '').slice(-8)}`,
      certificateId: 'AB12',
      cardId,
      partnerPrivateKeyPem: partner.privateKey,
      partnerCertificatePem: partner.certificate,
      samsungCertificatePem: samsung.certificate,
    },
  ]);
  // Test is where the wallets are open; the reviewer joins the team before anything is released.
  const reviewer = await templateReviewer(admin, org.id, [
    'template_reviewer',
    'template_publisher',
  ]);
  await reviewer.dispose();
});

// Google and Samsung are open in Test: each page starts in the mode the person turned on.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem('passbook-mode', 'test'));
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('a store card is made from its blueprint in the designer', async ({ page }) => {
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(org.id)}`);
  await page.getByRole('button', { name: 'Use Balance card' }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill(name);
  await page.getByRole('button', { name: 'Open designer' }).click();
  await page.waitForURL((u) => u.pathname.endsWith('/templates/new'));
  await expect(page.getByRole('region', { name: 'Issues' }).getByRole('status')).toHaveText(
    /to review|None/,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL((u) => /^\/admin\/o\/[^/]+\/templates\/[0-9a-f-]+$/.test(u.pathname));
  templateId = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('radio', { name: 'Test' })).toBeChecked();
  await page.goto(design('?mode=wallets&wallet=google'));
  await expect(rail(page)).toBeVisible();
  await shots(page, 'authoring-wallets-google');
});

test('roles are set, and the Google Loyalty and Samsung previews and reports show', async ({
  page,
}) => {
  await page.goto(design('?mode=wallets&wallet=google'));
  await expect(report(page, 'Google')).toContainText('Loyalty');
  await shots(page, 'authoring-google-before-roles');
  // Every suggestion in one step: the title that showed twice, the tier and the terms.
  await page.getByRole('button', { name: /^Accept 3/ }).click();
  await expect(page.getByRole('button', { name: /^Use .* for / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Title source: Empty/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tier source: Tier/ })).toBeVisible();
  await shots(page, 'authoring-google-roles');

  await rail(page)
    .getByRole('radio', { name: /^Samsung Wallet/ })
    .click();
  await expect(page).toHaveURL(/wallet=samsung/);
  await expect(report(page, 'Samsung')).toBeVisible();
  await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
  await shots(page, 'authoring-samsung-report');
});

test('Samsung and Google art is added and the version saved with the roles', async ({ page }) => {
  // The local e2e server cannot cut images (its Images binding is not there), and the coin strip
  // would be cut to Google's hero: the author drops it and gives each wallet art at its own size.
  await page.goto(design());
  await page.getByRole('button', { name: /^Images/ }).click();
  await page.getByRole('button', { name: 'Remove strip' }).click();
  await page.getByRole('radio', { name: 'Wallets' }).click();
  await page.getByRole('button', { name: /^Accept 3/ }).click();
  await open(page, /^Google images/);
  const google = page.locator('[data-target="wallets-images:google:logo"]');
  await google.locator('input[type=file]').setInputFiles(ART);
  await expect(google).toContainText('wallets/google/logo.png');
  const hero = page.locator('[data-target="wallets-images:google:hero"]');
  await hero.locator('input[type=file]').setInputFiles(png(1032, 336));
  await expect(hero).toContainText('wallets/google/hero.png');
  await rail(page)
    .getByRole('radio', { name: /^Samsung Wallet/ })
    .click();
  await open(page, /^Samsung images/);
  const samsung = page.locator('[data-target="wallets-images:samsung:logo"]');
  await samsung.locator('input[type=file]').setInputFiles(png(256, 256));
  await expect(samsung).toContainText('wallets/samsung/logo.png');
  const main = page.locator('[data-target="wallets-images:samsung:main"]');
  await main.locator('input[type=file]').setInputFiles(png(888, 288));
  await expect(main).toContainText('wallets/samsung/main.png');
  await shots(page, 'authoring-art');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText(/^Saved v/)).toBeVisible();
  const detail = await admin.get<{ versions: { version: string }[] }>(
    `/api/v1/templates/${templateId}?orgId=${org.id}`,
  );
  const latest = await admin.get<{ manifest: { wallets: Record<string, unknown> } }>(
    `/api/v1/templates/${templateId}/versions/${detail.versions[0]?.version}?orgId=${org.id}`,
  );
  expect(latest.manifest.wallets).toMatchObject({
    roles: { title: false },
    google: { images: { logo: 'wallets/google/logo.png' } },
    samsung: { images: { logo: 'wallets/samsung/logo.png' } },
  });
});

test('a package with wallets art imports with both wallet reports', async ({ page }) => {
  const zip = await (
    await admin.ctx.get(
      `/api/v1/templates/${encodeURIComponent(templateId)}/package?orgId=${org.id}`,
    )
  ).body();
  const imported = `Imported ${uid('i')}`;
  await page.goto(`/admin/templates/upload?orgId=${encodeURIComponent(org.id)}`);
  await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
  await page.getByRole('option', { name: org.name }).click();
  await page.getByLabel('Name', { exact: true }).fill(imported);
  await page.locator('input[type=file]').setInputFiles({
    name: 'package.pkpasstemplate',
    mimeType: 'application/zip',
    buffer: zip,
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: imported })).toBeVisible({
    timeout: 60_000,
  });
  const uploads = await admin.get<{ items: { uploadId: string }[] }>(
    `/api/v1/templates/uploads?orgId=${org.id}&limit=5`,
  );
  importUrl = `/admin/o/${encodeURIComponent(org.id)}/templates/upload?upload=${uploads.items[0]?.uploadId}`;
  await page.goto(importUrl);
  const wallets = page.getByRole('region', { name: 'Wallet reports' });
  await expect(wallets.getByTestId('google-report')).toBeVisible();
  await expect(wallets.getByTestId('samsung-report')).toBeVisible();
  await expect(wallets.getByTestId('google-report')).toContainText('Ready');
  await expect(wallets.getByTestId('samsung-report')).toContainText('Ready with omissions (1)');
  await shots(page, 'authoring-import-report');
});

test('the Apple Test release carries Google on its own', async () => {
  await publishTemplateVersion(admin, org.id, templateId, await latestVersion(), 'test');
  // Nothing is lost on Google: the platform approves and releases it itself.
  await syncUntil(async () => (await active('google')) !== null, 'the Google release');
});

const walletRow = (page: Page, wallet: 'Google' | 'Samsung') =>
  page
    .getByRole('list', { name: 'Wallets' })
    .getByRole('listitem')
    .filter({ hasText: `${wallet} Wallet` });
const releasesTab = async (page: Page) => {
  await page.goto(
    `/admin/o/${encodeURIComponent(org.id)}/templates/${encodeURIComponent(templateId)}`,
  );
  await page.getByRole('tab', { name: 'Releases' }).click();
};

test('the one omission is approved item by item and Samsung is released', async ({ page }) => {
  await releasesTab(page);
  await expect(walletRow(page, 'Google')).toContainText('Released');
  const row = walletRow(page, 'Samsung');
  await expect(row).toContainText('Ready with omissions (1)');
  await row.getByRole('button', { name: 'Review Samsung Wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review Samsung Wallet' });
  await expect(dialog).toBeVisible();
  // Nothing is approved until the item is: both buttons wait for the box.
  const release = dialog.getByRole('button', { name: 'Approve and release' });
  await expect(release).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Samsung sharing is not restricted/ }).check();
  await shots(page, 'authoring-review-dialog');
  await release.click();
  await expect(page.getByText('Released to Samsung Wallet')).toBeVisible();
  await expect(walletRow(page, 'Samsung')).toContainText('Released');
  await expect(walletRow(page, 'Samsung')).toContainText('Ready with omissions (1)');
  expect(await active('samsung')).not.toBeNull();
});

const GALAXY_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** A Test pass on the template's Apple release, from the version's own sample input. */
async function issue() {
  const apple = await requireActiveTemplateRelease(admin, org.id, templateId, 'test');
  const version = await admin.get<{ manifest: { sample: Record<string, unknown> } }>(
    `${path()}/versions/${apple.version}?orgId=${org.id}`,
  );
  const made = await admin.send<{ id: string; publicUrl: string }>(
    'POST',
    '/api/v1/passes',
    {
      orgId: org.id,
      templateId,
      templateVersion: apple.version,
      releaseId: apple.id,
      releaseGeneration: apple.generation,
      mode: 'test',
      input: version.manifest.sample,
      holderEmail: `${uid('holder')}@example.test`,
    },
    { ...TEST, 'Idempotency-Key': uid('idem') },
  );
  return new URL(made.publicUrl).pathname;
}

/** What a holder on each phone is offered: the wallets' badges on the pass page. */
async function badges(browser: Browser, passPath: string) {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  const found = { google: 0, samsung: 0 };
  for (const [wallet, options] of [
    ['google', pixel],
    ['samsung', { ...pixel, userAgent: GALAXY_UA }],
  ] as const) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      await page.goto(passPath);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      found[wallet] = await page
        .getByRole('link', {
          name: wallet === 'google' ? 'Add to Google Wallet' : 'Add to Samsung Wallet',
        })
        .count();
    } finally {
      await context.close();
    }
  }
  return found;
}

test('a pass is issued and the holder sees both wallets', async ({ browser }) => {
  firstPass = await issue();
  expect(await badges(browser, firstPass)).toEqual({ google: 1, samsung: 1 });
});

test('a template change that adds an omission reads Review needed and pauses offers until approved', async ({
  page,
  browser,
}) => {
  // Leaving the terms out of Google on purpose is a new thing a holder does not see.
  await page.goto(design('?mode=wallets&wallet=google'));
  await open(page, /^Google fields/);
  await page.getByRole('switch', { name: 'Show Terms on Google Wallet' }).uncheck();
  await expect(report(page, 'Google')).toContainText('Ready with omissions (1)');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText(/^Saved v/)).toBeVisible();
  const version = await latestVersion();
  await publishTemplateVersion(admin, org.id, templateId, version, 'test');
  // The platform authors its candidate for the new release; it waits for the one approval.
  await syncUntil(
    async () => (await systemCandidates('google')).some((c) => c.version === version),
    'the platform Google candidate',
  );

  // The row and the runtime agree. The row asks for review of the new omission; at runtime the new
  // Apple release has no approved Google projection, so a pass on it gets no Google offer.
  await releasesTab(page);
  await expect(walletRow(page, 'Google')).toContainText('Review needed: new omission');
  await expect(walletRow(page, 'Google')).not.toContainText('Released');
  const second = await issue();
  expect((await badges(browser, second)).google).toBe(0);
  await shots(page, 'authoring-new-omission');

  // One approval opens the new release's offers.
  await walletRow(page, 'Google').getByRole('button', { name: 'Review Google Wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review Google Wallet' });
  await expect(dialog.getByText('New', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Left out by the template/ }).check();
  await dialog.getByRole('button', { name: 'Approve and release' }).click();
  await expect(page.getByText('Released to Google Wallet')).toBeVisible();
  await expect(walletRow(page, 'Google')).toContainText('Released');
  expect((await badges(browser, second)).google).toBe(1);
});

test('a one-person organization approves its own omission with the alone rule', async ({
  page,
  browser,
}) => {
  const sole = await enrolledOrg(admin, 'sole', [googleCredential()]);
  const made = await admin.send<{ id: string; versions: { version: string }[] }>(
    'POST',
    `/api/v1/templates/${encodeURIComponent('baked:starter-day-pass')}/use`,
    { orgId: sole.id, name: `Sole ${uid('s')}` },
  );
  // Alone, the author's own Apple approval in Test says so (`alone`), and no reviewer ever joins.
  const base = `/api/v1/templates/${encodeURIComponent(made.id)}`;
  const scope = { orgId: sole.id, mode: 'test', provider: 'apple' };
  const candidate = await admin.send<{ id: string; candidateHash: string }>(
    'POST',
    `${base}/candidates`,
    { ...scope, version: made.versions[0]?.version },
    TEST,
  );
  const approval = await admin.send<{ id: string }>(
    'POST',
    `${base}/candidates/${encodeURIComponent(candidate.id)}/approve`,
    { ...scope, candidateHash: candidate.candidateHash, alone: true },
    TEST,
  );
  await admin.send(
    'POST',
    `${base}/releases`,
    {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    },
    TEST,
  );
  const apple = await requireActiveTemplateRelease(admin, sole.id, made.id, 'test');
  const system = () =>
    admin.send<{ items: { authorId: string }[] }>(
      'GET',
      `${base}/candidates?${new URLSearchParams({ orgId: sole.id, mode: 'test', provider: 'google' })}`,
      undefined,
      TEST,
    );
  await syncUntil(
    async () => (await system()).items.some((c) => c.authorId.startsWith('system:')),
    'the platform Google candidate',
  );

  await page.goto(
    `/admin/o/${encodeURIComponent(sole.id)}/templates/${encodeURIComponent(made.id)}`,
  );
  await page.getByRole('tab', { name: 'Releases' }).click();
  await expect(walletRow(page, 'Google')).toContainText('Ready with omissions (1)');
  await walletRow(page, 'Google').getByRole('button', { name: 'Review Google Wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review Google Wallet' });
  await expect(
    dialog.getByText('You are the only reviewer. This approves your own work.'),
  ).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await shots(page, 'authoring-alone-dialog');
  await dialog.getByRole('button', { name: 'Approve and release' }).click();
  await expect(page.getByText('Released to Google Wallet')).toBeVisible();
  await expect(walletRow(page, 'Google')).toContainText('Released');

  const pass = await testPass(admin, { org: sole, apple });
  expect((await badges(browser, pass.path)).google).toBe(1);
});

/** Serious and critical findings at 1440 and 834, light and dark. */
async function expectNoSerious(page: Page, what: string) {
  for (const [width, height] of [
    [1440, 900],
    [834, 1112],
  ] as const)
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
      expect(serious, `${what} at ${width} ${scheme}`).toEqual([]);
    }
}

test('axe finds nothing serious on the tab, the release rows, the review and the import report', async ({
  page,
}) => {
  await page.goto(design('?mode=wallets&wallet=samsung'));
  await expect(report(page, 'Samsung')).toBeVisible();
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await expectNoSerious(page, 'the Wallets tab');

  await page.setViewportSize({ width: 1440, height: 900 });
  await releasesTab(page);
  await expect(walletRow(page, 'Google')).toContainText('Released');
  await expectNoSerious(page, 'the release rows');
  await walletRow(page, 'Samsung').getByRole('button', { name: 'Review Samsung Wallet' }).click();
  await expect(page.getByRole('dialog', { name: 'Review Samsung Wallet' })).toBeVisible();
  await page.waitForTimeout(800);
  await expectNoSerious(page, 'the review dialog');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(importUrl);
  await expect(page.getByTestId('google-report')).toBeVisible();
  await expectNoSerious(page, 'the import report');
});
