import { expect, test } from '@playwright/test';

test('serves the SPA and health', async ({ page, request }) => {
  expect((await request.get('/health')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wallet' })).toBeVisible();
});
