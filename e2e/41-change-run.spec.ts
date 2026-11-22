import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('change passes from the list: select, change, preview, run, undo', async ({ page }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const tag = uid('CHG').toUpperCase();
  const passes = [
    await createPass(admin, orgId, { holder: `${tag} Ana` }),
    await createPass(admin, orgId, { holder: `${tag} Ben` }),
  ];
  const tierOf = async (id: string) =>
    (await admin.get<{ personalization: { tier?: string } }>(`/api/v1/passes/${id}`))
      .personalization.tier;
  const before = await tierOf(passes[0].id);
  expect(before).not.toBe('Pro');

  // Select both rows and open Change.
  await page.goto(`/admin/passes?orgId=${encodeURIComponent(orgId)}&q=${tag}`);
  await page.getByRole('checkbox', { name: 'Select all passes on this page' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page).toHaveURL(/\/passes\/change$/);

  // Set Tier to Pro; holders are told only when Notify is on, and it starts off.
  await page.getByRole('button', { name: 'Add a field' }).click();
  await page.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Tier' }).click();
  await page.getByRole('combobox', { name: 'Value' }).click();
  await page.getByRole('option', { name: 'Pro' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Notify holders' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Review is the server's dry run.
  await expect(page.getByText('Will change')).toBeVisible();
  await page.getByRole('button', { name: 'Change 2 passes' }).click();
  await expect(page.getByText('2 changed')).toBeVisible({ timeout: 60_000 });
  expect(await tierOf(passes[0].id)).toBe('Pro');
  expect(await tierOf(passes[1].id)).toBe('Pro');

  // Undo restores both, silently.
  await page.getByRole('button', { name: 'Undo change' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo change' }).click();
  await expect(page.getByText(/Restored 2\./)).toBeVisible({ timeout: 60_000 });
  expect(await tierOf(passes[0].id)).toBe(before);

  await admin.dispose();
});
