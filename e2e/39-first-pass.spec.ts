import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(120_000);

test('a new org goes from the path card to a pass waiting on a phone', async ({ page }) => {
  const api = await apiAs('admin');
  const slug = uid('fp').toLowerCase();
  const org = await api.send('POST', '/api/v1/orgs', {
    slug,
    name: `First pass ${slug}`,
    addMe: true,
  });
  await api.dispose();

  await page.goto(`/admin/o/${org.id}`);
  const path = page.getByRole('region', { name: 'First pass' });
  await expect(path).toBeVisible();
  await path.getByRole('link', { name: 'Monthly pass' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Gym membership');
  await page.getByRole('button', { name: 'Create' }).click();

  await page.waitForURL(/\/templates\/[^/]+$/);
  await page.getByRole('button', { name: 'Try on my phone' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Try on my phone' });
  await expect(sheet.getByText('Release v1 to Test')).toBeVisible();
  await expect(sheet.getByText('Waiting for your phone')).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole('button', { name: /^Release/ })).toBeDisabled();
});
