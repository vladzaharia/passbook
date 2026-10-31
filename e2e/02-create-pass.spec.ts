import { expect, test } from '@playwright/test';
import { uid } from './helpers/api.ts';
import { readPkpass } from './helpers/pkpass.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test("admin creates a Henry's pass with the wizard and downloads a valid .pkpass", async ({
  page,
  context,
}) => {
  const memberId = uid('E2E').toUpperCase();
  const memberName = `Wizard ${memberId}`;
  const holder = `${memberId.toLowerCase()}@example.test`;

  await page.goto('/admin/passes/new');
  await page.getByRole('button', { name: /Henry/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: /Blue Entrance/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Member name').fill(memberName);
  await page.getByLabel('Member number').fill(memberId);
  await page.getByLabel('Membership').fill('E2E Plan');
  // Live preview follows the form (debounced).
  const preview = page.getByRole('region', { name: /preview/i }).or(page.locator('main'));
  await expect(preview.getByText(memberName).first()).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Holder email').fill(holder);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create pass' }).click();

  await page.waitForURL(/\/admin\/passes\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(memberName);
  // Front and back faces are both rendered by PassCard.
  await expect(page.locator('main').getByText(memberName).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Holder' }).click();
  await expect(page.getByText(holder).first()).toBeVisible();

  // The public page is the UI route to the download.
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open public page' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const downloadPromise = popup.waitForEvent('download');
  await popup.getByRole('link', { name: 'Add to Apple Wallet' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pkpass$/);

  const { names, passJson } = await readPkpass(download);
  expect(names).toEqual(expect.arrayContaining(['pass.json', 'manifest.json', 'signature']));
  expect(passJson.passTypeIdentifier).toBe('pass.im.plrs.wallet');
  expect(JSON.stringify(passJson)).toContain(memberName);
});
