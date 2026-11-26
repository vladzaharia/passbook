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

  // Signed out: no authenticated call on a docs page, and the moved tool pages redirect into the Workbench.
  for (const path of ['/developers/reference/passes', '/developers']) {
    await page.goto(path);
    await page.waitForTimeout(800);
  }
  expect(failures).toEqual([]);
  await page.goto('/developers/console');
  await page.waitForURL((u) => u.pathname === '/workbench/console');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sign in to use the Workbench' }),
  ).toBeVisible();
  await expect(
    page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }),
  ).toBeVisible();
  await shot(page, 'console-signed-out');
  // The playground is the Workbench's Design area, public signed out.
  await page.goto('/developers/playground');
  await page.waitForURL((u) => u.pathname === '/workbench/design');
  await shot(page, 'design-signed-out');

  // Sign in and make sure there is a sandbox.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // Polaris ID lands straight on the page, so wait for the island to pick a state.
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  let requestId: string | null = null;
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
    // A call with the sandbox's own key leaves a request id to paste into the search below.
    const key = /PASSBOOK_KEY=(pbp_test_\S+)/.exec(
      (await page.locator('.qs-env-v').textContent()) ?? '',
    )?.[1];
    if (key) {
      const call = await page.request.get('/api/v1/templates', {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(call.status()).toBe(200);
      requestId = call.headers()['x-request-id'] ?? null;
    }
  }
  // An operation page runs in the Workbench: Run in Workbench opens the Console on that operation, no body in the URL.
  await page.goto('/developers/reference/passes/create');
  const runLink = page.getByRole('main').getByRole('link', { name: 'Run in Workbench' }).first();
  await expect(runLink).toHaveAttribute('href', '/workbench/console?op=passes.postPasses');
  await runLink.click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/console\?op=passes\.postPasses/);
  expect(page.url()).not.toMatch(/body=/);

  // The webhook tester, URL endpoints and their Admin rows are the Events tool's (T3 rebuilds it and
  // owns its spec); this one keeps to the docs islands.
  expect(errors).toEqual([]);

  // The companion link: signed in it opens the Workbench.
  await page.goto('/developers');
  await expect(page.locator('[data-menubar] [data-wb-link]')).toHaveAttribute('href', '/workbench');

  // D12 and D6: ⌘K returns focus to the Search button; a pasted request id opens its own row.
  await page.goto('/developers');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-search')))
    .toBe(true);
  // A pasted request id finds its request and opens it in the Logs tool, selected.
  if (requestId) {
    await page.keyboard.press('Control+k');
    await page.keyboard.type(requestId);
    const found = page.getByRole('option').filter({ hasText: /GET \/templates/ });
    await expect(found).toBeVisible();
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/workbench/o/[^/]+/logs.*${requestId}`, 'i'));
    await expect(
      page.getByRole('listbox', { name: 'Requests' }).getByRole('option').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[role="option"][aria-selected="true"]')).toBeVisible();
  }
});
