import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

// More than 100 passes match, so voiding all of them goes through a bulk run, not the inline path.
const COUNT = 101;
const prefix = uid('BR').toUpperCase();

test('select all matching, void in the background, watch it finish', async ({ page }) => {
  test.setTimeout(420_000);
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  for (let i = 0; i < COUNT; i++)
    await createPass(api, orgId, { holder: `Run ${i}`, memberId: `${prefix}-${1000 + i}` });
  await api.dispose();

  await page.goto(`/admin/passes?orgId=${encodeURIComponent(orgId)}`);
  const bar = page.getByRole('combobox', { name: 'Find passes' });
  await bar.click();
  await bar.pressSequentially(`${prefix}-`);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`${prefix}-1000`)).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select all passes on this page' }).check();
  await page.getByRole('button', { name: `Select all ${COUNT} matching` }).click();
  await expect(page.getByText(`All ${COUNT} matching selected`)).toBeVisible();

  const selection = page.getByRole('region', { name: 'Selection' });
  await selection.getByRole('button', { name: 'Void' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Void' }).click();

  const card = page.getByRole('region', { name: 'Bulk run' });
  await expect(card).toBeVisible();
  // The card survives a reload while the run (or its result) is current.
  await page.reload();
  await expect(card).toBeVisible();
  await expect(card.getByText(`${COUNT} voided`)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('Voided').first()).toBeVisible();
});
