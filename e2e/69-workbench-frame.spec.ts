import { expect, type Page, test } from '@playwright/test';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** Needs the prerendered portal: `WALLET_E2E_PREVIEW=1` (tools/e2e-server.ts builds it). */
const TOOLS = ['console', 'webhooks', 'logs', 'keys'] as const;
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

/** At each width: the switcher, the h1 and the toolbar have the same box on every tool, and nothing scrolls sideways. */
async function sameFrame(page: Page) {
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    const seen: Record<string, Box[]> = { switcher: [], h1: [], toolbar: [] };
    for (const tool of TOOLS) {
      await page.goto(`/developers/${tool}`);
      await page.waitForLoadState('networkidle');
      seen.switcher?.push(await box(page, 'nav[aria-label="Workbench"]'));
      seen.h1?.push({ ...(await box(page, 'h1')), width: 0 });
      seen.toolbar?.push({ ...(await box(page, '[data-bench-toolbar]')), height: 0 });
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(sideways, `${tool} at ${width}`).toBeLessThanOrEqual(0);
    }
    for (const [part, boxes] of Object.entries(seen))
      for (const b of boxes) expect(b, `${part} at ${width}`).toEqual(boxes[0]);
  }
}

test('the Workbench frame: one bench, the same boxes on all four tools', async ({ page }) => {
  // Signed out: the prerendered frame.
  await sameFrame(page);

  // Skip to tool follows Skip to content and lands on the tool.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/developers/logs');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to tool');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('id', 'tool');
  // The bar has no sandbox chip on a tool page; the strip carries it.
  await expect(page.locator('[data-menubar] [data-island="org-chip"]')).toHaveCount(0);

  // Signed in with a sandbox (spec 35 makes the builder's; this makes one if it is missing).
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
  await page.goto('/developers/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }

  await sameFrame(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const tool of TOOLS) {
    await page.goto(`/developers/${tool}`);
    const strip = page.locator('.bench-ctx');
    await expect(strip.getByText('Test', { exact: true })).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Sandbox menu' })).toBeVisible();
    if (tool === 'console') await expect(strip.getByText('Run here')).toBeVisible();
    else await expect(strip.locator('.bench-key code')).toHaveText(/^\S+…$/);
    if (tool === 'logs') await expect(page.locator('[data-bench-status] .logs-live')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shots(page, `bench-${tool}`);
  }
  // The strip's menu.
  await page.goto('/developers/logs');
  await page.locator('.bench-ctx').getByRole('button', { name: 'Sandbox menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Workbench home' })).toBeFocused();
  await shots(page, 'bench-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

/** What the page's view transition did: `ran` with its types, or `skipped`; null with none at all. */
const transition = (page: Page) =>
  page.evaluate(() => (window as unknown as { benchVt: unknown }).benchVt ?? null);

test.describe('the tool switch', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('slides between tools under a head that holds still', async ({ page }) => {
    await page.addInitScript(() => {
      addEventListener('pagereveal', (e) => {
        const vt = (e as Event & { viewTransition: ViewTransition | null }).viewTransition;
        const w = window as unknown as { benchVt: unknown };
        if (!vt) return;
        const seen: { state: string; types: string[] } = { state: 'pending', types: [] };
        w.benchVt = seen;
        // Read after bench-vt.js has typed or skipped it.
        vt.ready.then(
          () => {
            seen.state = 'ran';
            seen.types = [...((vt as unknown as { types?: Set<string> }).types ?? [])];
          },
          () => {
            seen.state = 'skipped';
          },
        );
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/developers/console');
    const head = await box(page, '#bench-head');
    const switcher = page.getByRole('navigation', { name: 'Workbench' });
    await switcher.getByRole('link', { name: 'Logs' }).click();
    await page.waitForURL('**/developers/logs');
    await expect.poll(() => transition(page)).toEqual({ state: 'ran', types: ['bench-next'] });
    expect(await box(page, '#bench-head')).toEqual(head);
    await switcher.getByRole('link', { name: 'Webhooks' }).click();
    await page.waitForURL('**/developers/webhooks');
    await expect.poll(() => transition(page)).toEqual({ state: 'ran', types: ['bench-back'] });
    // From a docs page into a tool: skipped.
    await page.goto('/developers/guides');
    await page
      .getByRole('navigation', { name: 'Docs' })
      .getByRole('link', { name: 'Keys', exact: true })
      .click();
    await page.waitForURL('**/developers/keys');
    await expect.poll(() => transition(page)).toMatchObject({ state: 'skipped' });
  });
});
