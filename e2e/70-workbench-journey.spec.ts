import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { signInToWorkbench } from './helpers/workbench.ts';

/** The Workbench as one bench. Needs the prerendered portal: `WALLET_E2E_PREVIEW=1` (tools/e2e-server.ts builds it). */
const TOOLS = ['console', 'events', 'logs', 'keys'] as const;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

const signIn = (page: Page) => signInToWorkbench(page);

type Box = { x: number; y: number; width: number; height: number };

/** A menu closes when the page scrolls, so scroll its trigger into view and let the scroll settle before opening it. */
async function openMenu(page: Page, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('the frame: the title sits in the same place on all four tools', async ({ page }) => {
  await signIn(page);
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    const heads: Box[] = [];
    for (const tool of TOOLS) {
      await page.goto(`/workbench/${tool}`);
      await page.waitForURL(new RegExp(`/workbench/o/[^/]+/${tool}$`));
      const h1 = page.getByRole('main').getByRole('heading', { level: 1 }).first();
      await expect(h1).toBeVisible();
      const hb = await h1.boundingBox();
      if (!hb) throw new Error(`${tool}: no heading box`);
      heads.push({
        x: Math.round(hb.x),
        y: Math.round(hb.y),
        // A name is as wide as its letters: the place is shared.
        width: 0,
        height: 0,
      });
      // The buddy's props (a cable, a lens) never scroll the page sideways.
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(sideways, `${tool} at ${width}`).toBeLessThanOrEqual(0);
    }
    // Same column; a tool's own notice may move the title a few pixels down on a phone.
    for (const [i, b] of heads.entries()) {
      expect(b.x, `${TOOLS[i]} at ${width}`).toBe(heads[0]?.x);
      expect(Math.abs(b.y - (heads[0]?.y ?? 0)), `${TOOLS[i]} at ${width}`).toBeLessThanOrEqual(8);
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
  await page.goto('/workbench/console?op=passes.postPasses');
  await expect(page.getByRole('heading', { level: 1, name: 'Console' })).toBeVisible();
  const run = page.getByRole('button', { name: /^Run/ }).first();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.locator('.stamp')).toContainText(/^2\d\d/, { timeout: 20_000 });
  const requestId = await page.locator('.cr-h .bench-id-c').getAttribute('title');
  expect(requestId).toBeTruthy();

  // 2. Logs: the request id from the response opens that request, selected.
  await page.getByRole('link', { name: 'View in Logs' }).click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/logs#/);
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(requestId);
  const trace = page.getByRole('navigation', { name: 'Trace' });
  await expect(trace).toBeVisible();
  // The Logs list holds the Console run: the row is in its list, not pinned over an empty one.
  await expect(page.getByRole('listbox', { name: 'Requests' }).getByRole('option')).not.toHaveCount(
    0,
  );
  await expect(page.getByText('Not in this view')).toHaveCount(0);
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
  await page.waitForURL(/\/workbench\/o\/[^/]+\/events\?request=/);
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
  await page.waitForURL(/\/workbench\/o\/[^/]+\/logs\?source=all#/);
  await openMenu(
    page,
    page
      .getByRole('navigation', { name: 'Trace' })
      .locator('[data-kind="key"]')
      .getByRole('button', { name: 'Open key' }),
  );
  await page.getByRole('menuitem', { name: 'Keys', exact: true }).click();
  await page.waitForURL(/\/workbench\/o\/[^/]+\/keys#/);
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(keyId);
  await expect(page.locator('[role="option"][aria-selected="true"]')).toBeVisible();
});

test('axe: no serious findings on any tool at three widths', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    for (const tool of TOOLS) {
      await page.goto(`/workbench/${tool}`);
      await page.waitForURL(new RegExp(`/workbench/o/[^/]+/${tool}$`));
      await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
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
