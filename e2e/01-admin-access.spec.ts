import { expect, test } from '@playwright/test';
import { signInAs, startOidcAs } from './helpers/auth.ts';

test('admin signs in through Pocket ID and lands on the admin overview', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  await startOidcAs(page, 'admin', '/admin');
  await page.waitForURL('**/admin');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a user-group account without memberships cannot open /admin', async ({ page }) => {
  await signInAs(page, 'user', '/');
  // Keep this no-membership case independent of grants left in a persisted local database.
  await page.route('**/api/v1/orgs/memberships/me', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/v1/orgs')).status);
  expect(status).toBe(403);
});

test('an account with no group is refused with the short page', async ({ page }) => {
  await startOidcAs(page, 'nobody', '/');
  await expect(page.getByText('This Polaris ID account cannot use PassBook.')).toBeVisible();
  const session = await page.evaluate(
    async () => (await (await fetch('/api/v1/session')).json()).authenticated,
  );
  expect(session).toBe(false);
});
