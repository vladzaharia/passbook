import { expect, type Page, test } from '@playwright/test';
import { shots as allShots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** SHOT_ONLY=a,b takes only those states (a re-shoot after a fix). */
const only = process.env.SHOT_ONLY?.split(',');
const shots = (page: Page, name: string, view = false) =>
  !only || only.includes(name) ? allShots(page, name, view) : Promise.resolve();

/** The Console on the Workbench. Needs the prerendered portal: `WALLET_E2E_PREVIEW=1`. */
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

test('the Console: opens on a read, runs with Cmd+Enter, and its request id opens Logs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/developers/console');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Console');
  await shots(page, 'console-signed-out');

  await signIn(page);
  await page.goto('/developers/console');
  const index = page.getByRole('listbox', { name: 'Operations' });
  await expect(index).toBeVisible();
  await expect(page.locator('[data-bench-count]')).toContainText(/\d+ operations/);

  // The default is the first GET, never the write that comes first.
  const selected = index.getByRole('option', { selected: true });
  await expect(selected).toContainText('GET');
  expect(new URL(page.url()).hash).not.toBe('');
  await expect(page.getByRole('button', { name: 'Run', exact: false }).first()).toBeEnabled();
  await page.waitForLoadState('networkidle');
  await shots(page, 'console-idle');

  // Cmd/Ctrl+Enter runs it from the list too.
  await index.focus();
  await page.keyboard.press('Control+Enter');
  const stamp = page.locator('.stamp');
  await expect(stamp).toContainText(/^2\d\d/);
  const rid = await page.locator('.cr-h .bench-id-c').getAttribute('title');
  expect(rid).toBeTruthy();
  await shots(page, 'console-response', true);
  // Each part's stylesheet came with its part (the tabs, the page, the lazy response): none is bare markup.
  const style = (selector: string, prop: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await style('.bench-tab', 'min-height')).toBe('36px');
  expect(await style('.console-op', 'display')).toBe('flex');
  expect(await style('.runbar', 'display')).toBe('flex');
  expect(await style('.cr', 'display')).toBe('grid');
  expect(await style('.cr-trace', 'border-top-style')).toBe('dashed');
  expect(await style('.bench-code', 'border-top-width')).not.toBe('');

  // The request id opens that request in Logs.
  await page.getByRole('link', { name: 'View in Logs' }).click();
  await page.waitForURL(/\/developers\/logs#/);
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(rid);
});

test('the Console: the JSON editor numbers each line once, and the index sheet opens below 1180', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/developers/console#passes.postPasses');
  await page.waitForLoadState('networkidle');
  const trigger = page.getByRole('button', { name: /Operation/ });
  await expect(trigger).toBeVisible();
  await page.getByRole('tab', { name: 'JSON' }).click();
  // One number per line of text: a wrapped line keeps its one number beside its first row.
  const lines = await page.locator('.editor pre .ln').count();
  const value = await page.getByLabel('Request body (JSON)').inputValue();
  expect(lines).toBe(value.split('\n').length);
  await shots(page, 'console-json');
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Operations' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(500);
  // It opens on the operation in use, not at the top of the list.
  const inUse = await sheet.getByRole('option', { selected: true }).boundingBox();
  const frame = await sheet.locator('.bench-sheet-b').boundingBox();
  expect(inUse && frame).toBeTruthy();
  if (inUse && frame) {
    expect(inUse.y).toBeGreaterThanOrEqual(frame.y - 1);
    expect(inUse.y + inUse.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  }
  await shots(page, 'console-index-sheet');
  await sheet
    .getByRole('option', { name: /List passes/ })
    .first()
    .click();
  await expect(sheet).toBeHidden();
  expect(decodeURIComponent(new URL(page.url()).hash)).toContain('#passes.getPasses');
});

test('the Console: a search with no match says so, and Clear brings the index back', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/developers/console');
  const index = page.getByRole('listbox', { name: 'Operations' });
  await expect(index).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find an operation' }).fill('zzzzzz');
  await expect(page.getByRole('region', { name: 'No matches' })).toBeVisible();
  await expect(index).toBeHidden();
  if (process.env.SHOTS_DIR && (!only || only.includes('console-nomatch')))
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: `${process.env.SHOTS_DIR}/console-nomatch-1440-${scheme}.png`,
      });
    }
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(index).toBeVisible();
});
