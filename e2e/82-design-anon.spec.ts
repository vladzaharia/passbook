import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stubTurnstile } from './helpers/turnstile.ts';

/** Design signed out and its hand-off into a sandbox (Workbench v2 §1.9, §8.1 item 5). Needs `WALLET_E2E_PREVIEW=1`. */
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

test('signed out: a blueprint in the designer, read only, with no API call', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/'))
      api.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    await page.goto('/workbench/design');
    await expect(page.getByRole('button', { name: 'Save to my sandbox' }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Design' })).toBeDisabled();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(sideways, `at ${width}`).toBeLessThanOrEqual(0);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      `at ${width}`,
    ).toEqual([]);
  }
  // Only the session probe: nothing about a template, a pass or an org.
  expect(api.filter((r) => !r.endsWith('/api/v1/session'))).toEqual([]);
});

test('the hand-off: edit, Save to my sandbox, sign in, sandbox made, template saved with the sample, issue', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await stubTurnstile(page);
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', 'e2e-designer');
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench/design');
  const field = page.locator('[role="tabpanel"] input[type="text"]').first();
  await field.fill('Casey River');
  await page.getByRole('button', { name: 'Save to my sandbox' }).first().click();
  await page.waitForURL((u) => u.pathname === '/login');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  // A first sign-in has no sandbox: it is made here, with its steps, and the save goes on.
  await page.getByRole('button', { name: 'Create sandbox' }).click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/design\/[^/?#]+/, { timeout: 120_000 });
  await expect(page.getByText(/^Saved as /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue test pass' })).toBeFocused();
  // The sample the visitor edited is the template's.
  await expect(page.locator('[role="tabpanel"] input[type="text"]').first()).toHaveValue(
    'Casey River',
  );
  await page.getByRole('button', { name: 'Issue test pass' }).click();
  await expect(page.getByText(/^Test pass issued /)).toBeVisible();
  await page.getByRole('button', { name: 'Passes' }).click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/passes/);
  await page.getByRole('link', { name: 'Logs' }).first().click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/logs/);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
});
