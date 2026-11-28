import { expect, type Page, test } from '@playwright/test';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

async function signIn(page: Page) {
  await stubTurnstile(page);
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', 'e2e-builder');
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
  await page.goto('/workbench/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  await page.setViewportSize({ width: 1440, height: 900 });
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // A track already done (an earlier spec's pass) opens on the Done page, with neither.
  await create
    .or(page.getByRole('radio', { name: 'Run here' }))
    .or(page.locator('.qs-done'))
    .waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/, {
      timeout: 90_000,
    });
  }
  await expect.poll(() => sandboxOrgId(page).catch(() => ''), { timeout: 60_000 }).not.toBe('');
  // A sandbox made by an earlier run of this server may have no key yet: the Workbench token needs one.
  await page.evaluate(async () => {
    const me = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    await fetch('/api/v1/developer/sandbox/key', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': me.csrfToken },
    });
  });
}

/** The Design index on the Workbench token: the templates, Start from a blueprint, and the designer it opens. Needs `WALLET_E2E_PREVIEW=1`. */
test('Design index: start from a blueprint, then the list holds it', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const org = await sandboxOrgId(page);
  await page.goto(`/workbench/o/${org}/design`);
  const start = page.getByRole('button', { name: 'Start from a blueprint' }).first();
  await expect(start).toBeVisible({ timeout: 20_000 });
  await shots(page, 'design-index-first');
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Choose a blueprint' });
  await expect(dialog.locator('ul button').first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'design-index-picker');
  await dialog.locator('ul button').first().click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/design\/[^/?#]+/, { timeout: 60_000 });
  await page.goto(`/workbench/o/${org}/design`);
  await expect(
    page.getByRole('list', { name: 'Templates' }).getByRole('link').first(),
  ).toBeVisible();
  await shots(page, 'design-index-list');
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});
