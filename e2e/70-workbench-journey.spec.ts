import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The Workbench as one bench. Needs the prerendered portal: `WALLET_E2E_PREVIEW=1` (tools/e2e-server.ts builds it). */
const TOOLS = ['console', 'webhooks', 'logs', 'keys'] as const;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

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
  await page.goto('/developers/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }
}

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

/** A menu closes when the page scrolls, so scroll its trigger into view and let the scroll settle before opening it. */
async function openMenu(page: Page, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('the frame: h1, switcher and toolbar sit in the same boxes on all four tools', async ({
  page,
}) => {
  await signIn(page);
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    const seen: Record<'switcher' | 'h1' | 'toolbar', Box[]> = {
      switcher: [],
      h1: [],
      toolbar: [],
    };
    for (const tool of TOOLS) {
      await page.goto(`/developers/${tool}`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1')).toBeVisible();
      seen.switcher.push(await box(page, 'nav[aria-label="Workbench"]'));
      seen.h1.push(await box(page, 'h1'));
      seen.toolbar.push(await box(page, '[data-bench-toolbar]'));
    }
    for (const [part, boxes] of Object.entries(seen)) {
      // A name is as wide as its letters, and a tool's own filters may wrap at a tablet width: the place is shared.
      const place = boxes.map((b) => {
        if (part === 'h1') return { ...b, width: 0 };
        if (part === 'toolbar') return { ...b, height: 0 };
        return b;
      });
      const first = place[0];
      for (const [i, b] of place.entries())
        expect(b, `${part} on ${TOOLS[i]} at ${width}`).toEqual(first);
    }
  }
});

test('the journey: a Console run opens its Logs row, its events in Webhooks, and its key in Keys', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. Console: issue a pass, a write that causes pass.issued.
  await page.goto('/developers/console#passes.postPasses');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Console');
  const run = page.getByRole('button', { name: /^Run/ }).first();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.locator('.stamp')).toContainText(/^2\d\d/);
  const requestId = await page.locator('.cr-h .bench-id-c').getAttribute('title');
  expect(requestId).toBeTruthy();

  // 2. Logs: the request id from the response opens that request, selected.
  await page.getByRole('link', { name: 'View in Logs' }).click();
  await page.waitForURL(/\/developers\/logs#/);
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(requestId);
  const trace = page.getByRole('navigation', { name: 'Trace' });
  await expect(trace).toBeVisible();
  await expect(page.locator('[role="option"][aria-selected="true"]')).toBeVisible();
  // The key that called, the request, and the event it caused, as one strip.
  await expect(trace.locator('[data-kind="key"]')).toHaveCount(1);
  await expect(trace.locator('[data-kind="event"]').first()).toBeVisible({ timeout: 20_000 });
  const keyId = await trace.locator('[data-kind="key"] .bench-id-c').getAttribute('title');
  expect(keyId).toBeTruthy();

  // 3. Webhooks: the request chip's menu opens the events it caused.
  await openMenu(
    page,
    trace.locator('[data-kind="request"]').getByRole('button', { name: 'Open request' }),
  );
  await page.getByRole('menuitem', { name: 'Events it caused' }).click();
  await page.waitForURL(/\/developers\/webhooks\?request=/);
  expect(new URL(page.url()).searchParams.get('request')).toBe(requestId);
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
  await list.getByRole('option').first().click();
  await expect(
    page.getByRole('navigation', { name: 'Trace' }).locator('[data-kind="request"]'),
  ).toBeVisible();

  // 4. Keys: back through the request to Logs, then the key chip opens the key, selected.
  await openMenu(
    page,
    page
      .getByRole('navigation', { name: 'Trace' })
      .locator('[data-kind="request"]')
      .getByRole('button', { name: 'Open request' }),
  );
  await page.getByRole('menuitem', { name: 'Logs', exact: true }).click();
  await page.waitForURL(/\/developers\/logs#/);
  await openMenu(
    page,
    page
      .getByRole('navigation', { name: 'Trace' })
      .locator('[data-kind="key"]')
      .getByRole('button', { name: 'Open key' }),
  );
  await page.getByRole('menuitem', { name: 'Keys', exact: true }).click();
  await page.waitForURL(/\/developers\/keys#/);
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(keyId);
  await expect(page.locator('[role="option"][aria-selected="true"]')).toBeVisible();
});

test('axe: no serious findings on any tool at three widths', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    for (const tool of TOOLS) {
      await page.goto(`/developers/${tool}`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1')).toBeVisible();
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        `${tool} at ${width}`,
      ).toEqual([]);
    }
  }
});
