import { expect, test } from '@playwright/test';

// Matches BREAKGLASS_TOKEN_SHA256 written by tools/e2e-server.ts.
const TOKEN = 'wbg_e2e-breakglass-token';

test('break-glass token signs in to the admin console without Pocket ID', async ({ page }) => {
  await page.goto('/auth/breakglass');
  await page.getByLabel('Token').fill('wbg_wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong token.');

  await page.getByLabel('Token').fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/admin/);
  const session = await page.evaluate(async () => (await fetch('/api/v1/session')).json());
  expect(session).toMatchObject({ authenticated: true, amr: 'breakglass' });
  expect(session.roles).toContain('admin');
});
