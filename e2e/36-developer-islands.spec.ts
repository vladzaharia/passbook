import { expect, test } from '@playwright/test';
import { stubTurnstile } from './helpers/turnstile.ts';

const SHOTS = process.env.ISLAND_SHOTS;
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Every width and theme, for the visual check. */
const shots = async (page: import('@playwright/test').Page, name: string) => {
  if (!SHOTS) return;
  const before = page.viewportSize();
  for (const [w, h] of [
    [1440, 900],
    [820, 1100],
    [390, 844],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png`, fullPage: true });
    }
  }
  if (before) await page.setViewportSize(before);
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

  // Signed out: no authenticated call on any page, no section current under Console, a sign-in action.
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
  await expect(
    page.getByRole('navigation', { name: 'Sections' }).locator('[aria-current]'),
  ).toHaveText('Workbench');
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
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // Polaris ID lands straight on the page, so wait for the island to pick a state.
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }
  await page.getByRole('radio', { name: 'Run here' }).click();
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

  // D10: Try it on an operation page is bound to the sandbox, and runs there.
  await page.goto('/developers/reference/passes/create');
  await expect(page.locator('[data-sandbox]')).toHaveText(/^test · \S+/);
  await expect(
    page.locator('.try').getByRole('button', { name: 'Run', exact: true }),
  ).toBeVisible();

  // D1: the webhook tester renders, with no Trusted Types error.
  await page.goto('/developers/webhooks');
  await expect(page.getByRole('tab', { name: 'Python' })).toBeVisible();
  await expect(
    page.locator('[data-island="webhook-tester"]').getByRole('button').first(),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'webhooks-signed-in');
  expect(errors).toEqual([]);

  // D8: a URL endpoint is added for real (the e2e server pins hooks.example.com, see WEBHOOK_TEST_DNS), its secret
  // shows once, a test send is listed tagged Test, and the secret can be rotated.
  const tester = page.locator('[data-island="webhook-tester"]');
  await tester.getByRole('button', { name: 'Add endpoint' }).click();
  await tester.getByLabel('URL').fill('https://nowhere.example.net/passbook');
  await tester.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tester.getByRole('alert')).toContainText('does not resolve');
  await shots(page, 'webhooks-add-refused');
  await tester.getByLabel('URL').fill('https://hooks.example.com/passbook');
  await tester.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tester.getByText('Shown once')).toBeVisible();
  await shots(page, 'webhooks-secret');
  await tester.getByRole('button', { name: 'Done' }).click();
  await expect(tester.getByText('Shown once')).toHaveCount(0);
  await expect(tester.locator('.wh-ep')).toHaveCount(2);
  await tester.getByRole('button', { name: 'Send test event' }).click();
  await expect(tester.getByText('Test', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await shots(page, 'webhooks-url-test');
  await tester.getByRole('button', { name: 'Rotate' }).click();
  await expect(tester.getByText(/The old one keeps signing for 24 hours/)).toBeVisible();
  await shots(page, 'webhooks-rotate-confirm');
  await tester.getByRole('button', { name: 'Rotate' }).click();
  await expect(tester.getByText('Shown once')).toBeVisible();
  await shots(page, 'webhooks-rotated');
  await tester.getByRole('button', { name: 'Done' }).click();
  await expect(tester.getByText('Shown once')).toHaveCount(0);
  expect(errors).toEqual([]);

  // The same test send is listed in Admin, tagged the same way.
  await page.goto('/admin/connections');
  await page.getByRole('tab', { name: 'Webhook endpoints' }).click();
  await page
    .getByRole('link', { name: /hooks\.example\.com/ })
    .first()
    .click();
  // The list page can match the text before the endpoint opens: wait for its URL, then read the table row.
  await page.waitForURL(/\/connections\/.*[0-9a-f]{8}-[0-9a-f]{4}-/);
  await expect(
    page.getByRole('main').getByRole('row').filter({ hasText: 'Test' }).first(),
  ).toBeVisible();
  await shots(page, 'admin-webhook-deliveries');

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
