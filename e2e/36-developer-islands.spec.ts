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

  // Signed out: no authenticated call on any page, Reference current under Console and Playground, a sign-in action.
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
    page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Reference' }),
  ).toHaveAttribute('aria-current', 'page');
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
  await create
    .or(page.getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')))
    .waitFor();
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

  // D8: an unresolvable URL is refused in the portal with the API's own message, nothing is added.
  const tester = page.locator('[data-island="webhook-tester"]');
  await tester.getByRole('button', { name: 'Add endpoint' }).click();
  await tester.getByLabel('URL').fill('https://hooks.example.com/passbook');
  await tester.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tester.getByRole('alert')).toBeVisible();
  await shots(page, 'webhooks-add-refused');
  await expect(tester.locator('.wh-ep')).toHaveCount(1);
  // The sandbox has no DNS, so the success path answers from a stub: the secret shows once, then a test send is listed.
  const endpoint = {
    id: '0193a1b2-7c00-7000-8000-0000000000e2',
    target: 'url',
    description: '',
    urlMasked: 'hooks.example.com/…',
    eventTypes: ['pass.issued', 'pass.updated'],
    status: 'active',
    lastStatus: 200,
  };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/webhook-endpoints', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill(json({ endpoint, secret: 'whsec_6f1d0c2a9b7e4d35a8c1' }, 201))
      : route.continue(),
  );
  await page.route(`**/api/v1/webhook-endpoints/${endpoint.id}/**`, (route) => {
    const url = route.request().url();
    if (url.endsWith('/test'))
      return route.fulfill(
        json({ ok: true, status: 200, durationMs: 41, errorCode: null, captureId: null }),
      );
    if (url.endsWith('/tests'))
      return route.fulfill(
        json({
          items: [
            {
              id: 't2',
              ok: false,
              status: 500,
              errorCode: null,
              durationMs: 88,
              at: Date.now() - 60_000,
            },
            {
              id: 't1',
              ok: true,
              status: 200,
              errorCode: null,
              durationMs: 41,
              at: Date.now() - 5_000,
            },
          ],
        }),
      );
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await tester.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tester.getByText('Shown once')).toBeVisible();
  await shots(page, 'webhooks-secret');
  await tester.getByRole('button', { name: 'Done' }).click();
  await tester.getByRole('button', { name: 'Send test event' }).click();
  await expect(tester.getByText('Test', { exact: true }).first()).toBeVisible();
  await shots(page, 'webhooks-url-test');
  await expect(tester.locator('.wh-ep')).toHaveCount(2);
  await page.unroute('**/api/v1/webhook-endpoints');
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
