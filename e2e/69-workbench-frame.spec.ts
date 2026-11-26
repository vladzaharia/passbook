import { expect, type Page, test } from '@playwright/test';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The Workbench frame: one shell, one tool head. Needs the prerendered portal: `WALLET_E2E_PREVIEW=1`. */
const TOOLS = [
  ['console', 'Console'],
  ['events', 'Events'],
  ['logs', 'Logs'],
  ['keys', 'Keys'],
] as const;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, selector: string): Promise<Box> => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  // Sub-pixel layout differs by font rasterizing only: compare whole pixels.
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
};

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
  const create = page.getByRole('button', { name: 'Create sandbox' });
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }
}

/** At each width: the sidebar and the head's title sit in the same place on every tool, and nothing scrolls sideways. */
async function sameFrame(page: Page) {
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    const seen: Record<'nav' | 'h1', Box[]> = { nav: [], h1: [] };
    for (const [tool, title] of TOOLS) {
      await page.goto(`/workbench/${tool}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      // The sidebar is the nav from 1024; below it the sheet holds it.
      if (width >= 1024) seen.nav.push(await box(page, 'nav[aria-label="Workbench"]'));
      seen.h1.push({ ...(await box(page, 'h1')), width: 0 });
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(sideways, `${tool} at ${width}`).toBeLessThanOrEqual(0);
    }
    for (const [part, boxes] of Object.entries(seen))
      for (const b of boxes) expect(b, `${part} at ${width}`).toEqual(boxes[0]);
  }
}

test('the Workbench frame: one shell, the same boxes on all four tools', async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  await sameFrame(page);

  // Skip to navigation leads the page, Skip to tool lands on the main area.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench/logs');
  await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to navigation');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to tool');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main');

  // The sidebar marks the area that is open, on every tool.
  for (const [tool, title] of TOOLS) {
    await page.goto(`/workbench/${tool}`);
    await expect(
      page
        .getByRole('navigation', { name: 'Workbench' })
        .getByRole('link', { name: title, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await shots(page, `bench-${tool}`);
  }
});

test.describe('the tool switch', () => {
  test('the head holds still while the sidebar moves between tools', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workbench/console');
    await expect(page.getByRole('heading', { level: 1, name: 'Console' })).toBeVisible();
    const head = await box(page, 'h1');
    const switcher = page.getByRole('navigation', { name: 'Workbench' });
    for (const [tool, title] of [
      ['logs', 'Logs'],
      ['events', 'Events'],
      ['keys', 'Keys'],
    ] as const) {
      await switcher.getByRole('link', { name: title, exact: true }).click();
      await page.waitForURL(new RegExp(`/workbench/o/[^/]+/${tool}`));
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      const now = await box(page, 'h1');
      expect({ x: now.x, y: now.y }).toEqual({ x: head.x, y: head.y });
    }
    // The old address follows the tool.
    const old = await page.request.get('/developers/logs', { maxRedirects: 0 });
    expect(old.status()).toBe(301);
    expect(old.headers().location).toBe('/workbench/logs');
  });
});
