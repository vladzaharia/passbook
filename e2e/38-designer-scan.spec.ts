import { expect, test } from '@playwright/test';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('the designer opens Scan screen in the production build', async ({ page }) => {
  const seed = readSeed();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('button', { name: 'Use Stamp card' }).click();
  await page.getByRole('button', { name: 'Open designer' }).click();
  await page.waitForURL((u) => u.pathname.endsWith('/templates/new'));
  await page.getByRole('radio', { name: 'Scan screen' }).click();
  await expect(page.getByTitle(/^Scanner screen/).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByText('Scan screen failed to load')).toHaveCount(0);
  expect(errors).toEqual([]);
});
