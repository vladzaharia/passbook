import { expect, test } from '@playwright/test';
import { stubTurnstile } from './helpers/turnstile.ts';

const SHOTS = process.env.ISLAND_SHOTS;
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Runs after 35, which makes the builder's sandbox; this one signs in as the same person and uses it. */
test('developer portal islands: signed out is quiet, signed in the tester, playground and search work', async ({
  page,
}) => {
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
  const failures: string[] = [];
  const errors: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 401 && r.url().includes('/api/v1/')) failures.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /TrustedHTML|Trusted Types/.test(m.text())) errors.push(m.text());
  });

  // Signed out: no authenticated call on any page, a Console nav item that is current, a sign-in action.
  for (const path of [
    '/developers/reference/passes',
    '/developers/logs',
    '/developers/console',
    '/developers/playground',
  ]) {
    await page.goto(path);
    await page.waitForTimeout(800);
  }
  expect(failures).toEqual([]);
  await page.goto('/developers/console');
  await expect(page.getByRole('link', { name: 'Console', exact: true }).first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('main').getByRole('link', { name: 'Sign in to try' })).toBeVisible();
  await shot(page, 'console-signed-out');
  await page.goto('/developers/playground');
  await shot(page, 'playground-signed-out');

  // The prerendered playground has a sample and its fields before script runs.
  const html = await (await page.request.get('/developers/playground')).text();
  expect(html).toContain('sample pass');
  expect(html).toContain('pg-fields');

  // Sign in and make sure there is a sandbox.
  await page.goto('/developers/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.getByText(/^PASSBOOK_KEY=pbp_test_/)).toBeVisible();
  }
  const requestId = await (async () => {
    const run = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/passes') && r.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Run', exact: true })
      .click()
      .catch(() => undefined);
    return (await run.catch(() => null))?.headers()['x-request-id'] ?? null;
  })();

  // D1: the webhook tester renders, with no Trusted Types error.
  await page.goto('/developers/webhooks');
  await expect(page.getByRole('tab', { name: 'Python' })).toBeVisible();
  await expect(
    page.locator('[data-island="webhook-tester"]').getByRole('button').first(),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'webhooks-signed-in');
  expect(errors).toEqual([]);

  // D10: the playground offers the sandbox instead of asking to sign in.
  await page.goto('/developers/playground');
  await expect(page.getByText(/Previews show each blueprint/)).toBeVisible();
  await expect(page.getByText('Sign in to edit them live')).toHaveCount(0);
  await shot(page, 'playground-signed-in');

  // D12 and D6: ⌘K returns focus to the Search button; a pasted request id opens its own row.
  await page.goto('/developers');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-search')))
    .toBe(true);
  if (requestId) {
    await page.keyboard.press('Control+k');
    await page.keyboard.type(requestId);
    const found = page.getByRole('option').filter({ hasText: 'POST /passes' });
    await expect(found).toBeVisible();
    await shot(page, 'search-request-id');
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname === '/developers/logs');
    expect(page.url().toLowerCase()).toContain(requestId.toLowerCase());
    await expect(page.locator('details[open] .logs-sum')).toBeVisible();
    await shot(page, 'logs-request-id');
  }
});
