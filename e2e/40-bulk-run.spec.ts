import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

// More than 100 passes match, so voiding all of them goes through a bulk run, not the inline path.
const COUNT = 101;
// 101 passes and a background run: each step gets longer than the default five seconds.
const slow = expect.configure({ timeout: 30_000 });
// The bar offers "ID starts with" only for ID-like text, which needs a digit; a random uid may have none.
const prefix = `${uid('BR').toUpperCase()}0`;

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
  // The ID offer needs the template's input fields, which load after the page; until then Enter
  // would take another offer. Wait for the offer itself.
  await slow(page.getByRole('option', { name: `ID starts with ${prefix}-` })).toBeVisible();
  await page.keyboard.press('Enter');
  await slow(page.getByText(`ID starts with ${prefix}-`)).toBeVisible();
  await slow(page.getByRole('link', { name: /^Run \d+$/ }).first()).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select all passes on this page' }).check();
  await page.getByRole('button', { name: `Select all ${COUNT} matching` }).click();
  await slow(page.getByText(`All ${COUNT} matching selected`)).toBeVisible();

  const selection = page.getByRole('region', { name: 'Selection' });
  await selection.getByRole('button', { name: 'Void' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Void' }).click();

  const card = page.getByRole('region', { name: 'Bulk run' });
  await slow(card).toBeVisible();
  // The card survives a reload while the run (or its result) is current.
  await page.reload();
  await slow(card).toBeVisible();
  await slow(card.getByText(`${COUNT} voided`)).toBeVisible({ timeout: 240_000 });
  await slow(page.getByText('Voided').first()).toBeVisible();
});
