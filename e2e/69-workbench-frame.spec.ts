import { expect, type Page, test } from '@playwright/test';
import { stubTurnstile } from './helpers/turnstile.ts';

/**
 * The Workbench frame around the four moved tools. The v1 bench head (switcher, strip, skip-to-tool,
 * the tool-switch view transition) was retired by the shell (design §4.4); what a docs reader and a
 * developer rely on is kept: the redirects land in the shell, one frame on every tool, nothing scrolls sideways.
 */
const TOOLS = ['console', 'events', 'logs', 'keys'] as const;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('the moved docs pages land in the Workbench shell, signed out, at every width', async ({
  page,
}) => {
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    for (const [from, to] of [
      ['/developers/console', '/workbench/console'],
      ['/developers/webhooks', '/workbench/events'],
      ['/developers/logs', '/workbench/logs'],
      ['/developers/keys', '/workbench/keys'],
    ] as const) {
      await page.goto(from);
      await page.waitForURL((u) => u.pathname === to);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Sign in to use the Workbench' }),
      ).toBeVisible();
      expect(await sideways(page), `${to} at ${width}`).toBeLessThanOrEqual(0);
    }
  }
});

test('signed in, every tool opens in the same frame and nothing scrolls sideways', async ({
  page,
}) => {
  test.setTimeout(120_000);
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // A track already done (an earlier spec's pass) opens on the Done page, with neither.
  await create
    .or(page.getByRole('radio', { name: 'Run here' }))
    .or(page.locator('.qs-done'))
    .waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }

  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    const heads: { x: number; y: number }[] = [];
    for (const tool of TOOLS) {
      await page.goto(`/workbench/${tool}`);
      await page.waitForURL(new RegExp(`/workbench/o/[^/]+/${tool}$`));
      await page.waitForLoadState('networkidle');
      const h1 = page.getByRole('main').getByRole('heading', { level: 1 }).first();
      await expect(h1).toBeVisible();
      const b = await h1.boundingBox();
      if (!b) throw new Error(`${tool}: no heading box`);
      heads.push({ x: Math.round(b.x), y: Math.round(b.y) });
      expect(await sideways(page), `${tool} at ${width}`).toBeLessThanOrEqual(0);
    }
    // The title sits in the same place on every tool.
    for (const [i, h] of heads.entries()) expect(h, `${TOOLS[i]} at ${width}`).toEqual(heads[0]);
  }
});
