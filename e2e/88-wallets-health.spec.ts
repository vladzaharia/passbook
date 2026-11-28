import { expect, type Page, test } from '@playwright/test';
import { type Api, apiAs } from './helpers/api.ts';
import { runMinuteCron } from './helpers/cron.ts';
import { shots } from './helpers/shots.ts';
import {
  googleCredential,
  localSql,
  MOCK,
  releaseSystemGoogle,
  requireE2eRelease,
  runCredentialCheck,
  testPass,
  type WalletOrg,
  walletOrg,
} from './helpers/wallets.ts';
import { saveToGoogle, seriousViolations } from './helpers/wallets-phone.ts';

// The org's wallet health panel in Brand and channels, and the Check again action on uncertain updates.
// Needs playwright.wallets.config.ts (Google is open in Test only).
test.describe.configure({ mode: 'serial' });
test.use({ storageState: 'e2e/.auth/admin.json' });

let admin: Api;
let w: WalletOrg;
let issuerId = '';
const scope = () => `org_id = '${w.org.id}' AND provider = 'google'`;
const ops = () => `instance_id IN (SELECT id FROM wallet_provider_instances WHERE ${scope()})`;

/** The Google row of Brand and channels, opened, and its health panel. */
async function health(page: Page, mode: 'test' | 'live' = 'test') {
  await page.addInitScript((m) => localStorage.setItem('passbook-mode', m), mode);
  await page.goto(`/admin/o/${w.org.id}/brand`);
  const row = page.getByRole('button', { name: /^Google Wallet/ });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  return page.getByRole('region', { name: 'Health' });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  const google = googleCredential();
  issuerId = google.issuerId;
  w = await walletOrg(admin, 'health', [google]);
  await releaseSystemGoogle(admin, w);
});
test.afterAll(async () => {
  await admin?.dispose();
});

test('an account with no copies yet shows no activity', async ({ page }) => {
  const panel = await health(page);
  await expect(panel.getByText('No activity')).toBeVisible();
  await shots(page, 'health-idle');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a saved pass makes the wallet healthy', async ({ page, browser }) => {
  const pass = await testPass(admin, w);
  await saveToGoogle(browser, pass.path);
  const panel = await health(page);
  await expect(panel.getByText('Healthy')).toBeVisible();
  await expect(
    panel.getByText('Last update').locator('xpath=following-sibling::dd'),
  ).not.toHaveText('None yet');
  await shots(page, 'health-ok');
  expect(await seriousViolations(page)).toEqual([]);
});

test('the loading skeleton is as tall as the loaded panel', async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/wallet-health', async (route) => {
    await gate;
    await route.continue();
  });
  await page.addInitScript(() => localStorage.setItem('passbook-mode', 'test'));
  await page.goto(`/admin/o/${w.org.id}/brand`);
  const row = page.getByRole('button', { name: /^Google Wallet/ });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  const skeleton = page.getByRole('status', { name: 'Loading' });
  await expect(skeleton).toBeVisible();
  const before = await skeleton.boundingBox();
  release();
  const panel = page.getByRole('region', { name: 'Health' });
  await expect(panel.getByText('Healthy')).toBeVisible();
  const after = await panel.boundingBox();
  console.log(`skeleton ${before?.height} loaded ${after?.height}`);
  expect(Math.abs((before?.height ?? 0) - (after?.height ?? 1))).toBeLessThanOrEqual(1);
  const tile = panel.getByText('Last update').locator('xpath=..');
  expect((await tile.boundingBox())?.height).toBe(54);
});

test('an unknown outcome inside the window settles by itself', async ({ page }) => {
  localSql(
    `UPDATE wallet_provider_instance_operations SET state = 'uncertain', claim_hash = lower(hex(randomblob(32))), claim_expires_at = 1, last_attempt_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE ${ops()}`,
  );
  const panel = await health(page);
  await expect(panel.getByText('1 update has an unknown outcome')).toBeVisible();
  await expect(panel.getByText('Needs attention')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check again' })).toBeDisabled();
  await shots(page, 'health-waiting');
  expect(await seriousViolations(page)).toEqual([]);
});

test('Check again settles an unknown outcome past the window', async ({ page }) => {
  localSql(`UPDATE wallet_provider_instance_operations SET last_attempt_at = 1 WHERE ${ops()}`);
  const panel = await health(page);
  const again = panel.getByRole('button', { name: 'Check again' });
  await expect(again).toBeEnabled();
  await shots(page, 'health-due');
  expect(await seriousViolations(page)).toEqual([]);
  await again.click();
  await expect
    .poll(
      async () => {
        await runMinuteCron();
        return panel.getByText(/unknown outcome/).count();
      },
      { message: 'the job settles the update', intervals: [1_000, 2_000], timeout: 45_000 },
    )
    .toBe(0);
});

test('credentials refused twice show as failing', async ({ page }) => {
  const credentialId = w.accounts.google ?? '';
  await fetch(`${MOCK}/__mock/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 404,
      match: `GET /walletobjects/v1/issuer/${issuerId}`,
      times: 2,
    }),
  });
  // Two definitive failures in a row make the account Failing; one would not.
  expect(await runCredentialCheck(admin, w.org.id, credentialId)).toBe('failed');
  expect(await runCredentialCheck(admin, w.org.id, credentialId)).toBe('failed');
  const panel = await health(page);
  await expect(panel.getByText('Credentials failing').first()).toBeVisible();
  await shots(page, 'health-failing');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a wallet that is not released in Live has no panel', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('passbook-mode', 'live'));
  await page.goto(`/admin/o/${w.org.id}/brand`);
  await expect(page.getByRole('heading', { name: /Brand|Channels/ }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Health' })).toHaveCount(0);
  await shots(page, 'health-live');
});
