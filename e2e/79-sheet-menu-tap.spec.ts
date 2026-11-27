import { expect, type Page, test } from '@playwright/test';
import { uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({
  storageState: 'e2e/.auth/admin.json',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/** Settles the sheet's slide; reducedMotion is on, so this only waits out the guard's window. */
const settle = (page: Page) => page.waitForTimeout(600);

async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${name}-390x844-vp-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Wizard bar menu: a tap on the trigger opens the sheet and selects nothing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const org = encodeURIComponent(readSeed().org.id);
  await page.goto(`/admin/o/${org}/connections/new?source=shopify-orders`);
  await page.getByLabel(/^Name/).fill(`E2E Tap ${uid('t')}`);
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.tap();
  await next.tap();
  await next.tap();
  await page.getByRole('button', { name: /^Create/ }).tap();
  await page.waitForURL(/\/connections\/[^/]+\/setup$/);

  const trigger = page.getByRole('button', { name: 'More actions' });
  await trigger.tap();
  const sheet = page.getByRole('menu');
  await expect(sheet).toBeVisible();
  await settle(page);
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'Leave setup?' })).toHaveCount(0);
  await shot(page, 'wizard-menu-tapped');

  // A mouse press and release does the same.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await trigger.click();
  await settle(page);
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'Leave setup?' })).toHaveCount(0);

  // A fresh tap on an item still selects it.
  await page.getByRole('menuitem', { name: 'Cancel' }).tap();
  await expect(page.getByRole('alertdialog', { name: 'Leave setup?' })).toBeVisible();
});

test('Account menu sheet: a tap on the trigger opens it and selects nothing', async ({ page }) => {
  const org = encodeURIComponent(readSeed().org.id);
  await page.goto(`/admin/o/${org}`);
  const trigger = page.getByRole('button', { name: 'Account menu' });
  await trigger.tap();
  const sheet = page.getByRole('menu');
  await expect(sheet).toBeVisible();
  await settle(page);
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/o/${org}/?$`));
  await shot(page, 'account-menu-tapped');
});

test.describe('mouse', () => {
  test.use({ hasTouch: false, isMobile: false });

  test('Account menu sheet: a mouse click on the trigger selects nothing, a fresh click does', async ({
    page,
  }) => {
    const org = encodeURIComponent(readSeed().org.id);
    await page.goto(`/admin/o/${org}`);
    const trigger = page.getByRole('button', { name: 'Account menu' });
    await trigger.click();
    const sheet = page.getByRole('menu');
    await expect(sheet).toBeVisible();
    await settle(page);
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/o/${org}/?$`));
    await page.getByRole('menuitem').first().click();
    await expect(sheet).toHaveCount(0);
  });

  test('Wizard bar menu: a mouse click on the trigger selects nothing', async ({ page }) => {
    test.setTimeout(120_000);
    const org = encodeURIComponent(readSeed().org.id);
    await page.goto(`/admin/o/${org}/connections/new?source=shopify-orders`);
    await page.getByLabel(/^Name/).fill(`E2E Mouse ${uid('m')}`);
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await next.click();
    await next.click();
    await next.click();
    await page.getByRole('button', { name: /^Create/ }).click();
    await page.waitForURL(/\/connections\/[^/]+\/setup$/);
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await settle(page);
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('alertdialog', { name: 'Leave setup?' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Leave setup?' })).toBeVisible();
  });
});
