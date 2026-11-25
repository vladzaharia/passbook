import { expect, test } from '@playwright/test';

test.describe('api key wizard', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('Enter in the Name field moves to the next step', async ({ page }) => {
    await page.goto('/admin/api-keys');
    await page.getByRole('button', { name: 'New API key' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New API key' });
    await dialog.getByLabel('Name').fill('Enter key');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'What it can do' })).toBeVisible();
  });
});
