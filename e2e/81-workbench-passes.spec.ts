import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** SHOT_ONLY=a,b takes only those states (a re-shoot after a fix). SHOTS_DIR names the folder; unset, a no-op. */
const only = process.env.SHOT_ONLY?.split(',');
const DIR = process.env.SHOTS_DIR;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** Every width and theme of a state: nothing serious or critical from axe, and a shot when asked for. */
async function shots(page: Page, name: string) {
  if (DIR) mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const found = (
        await new AxeBuilder({ page })
          // The bench IdChip's copy label does not start with its visible text (WCAG 2.5.3): bench's, not Passes'.
          .disableRules(['label-content-name-mismatch'])
          .analyze()
      ).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
      expect(
        found.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        `${name} ${width} ${scheme}`,
      ).toEqual([]);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(sideways, `${name} ${width}`).toBeLessThanOrEqual(0);
      if (!DIR || (only && !only.includes(name))) continue;
      await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

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
  await page.setViewportSize({ width: 1440, height: 900 });
  const create = page.getByRole('button', { name: 'Create sandbox' });
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/, {
      timeout: 90_000,
    });
  }
  await expect.poll(() => sandboxOrgId(page).catch(() => ''), { timeout: 60_000 }).not.toBe('');
  // A sandbox made by an earlier run of this server may have no key yet: the Workbench token needs one.
  await page.evaluate(async () => {
    const me = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    await fetch('/api/v1/developer/sandbox/key', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': me.csrfToken },
    });
  });
}

/** Issues a pass the way the docs do: the Console's createPass with its own sample, run once. */
async function issuePass(page: Page, org: string) {
  await page.goto(`/workbench/o/${org}/console?op=passes.postPasses`);
  const run = page.getByRole('button', { name: /^Run/ }).first();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.locator('.stamp')).toContainText(/^2\d\d/, { timeout: 20_000 });
}

/** The Passes tool on the Workbench token: list, inspector, simulate, Open in Console, void. Needs `WALLET_E2E_PREVIEW=1`. */
test('Passes: a pass, its events and devices, simulate, Open in Console, and void', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const org = await sandboxOrgId(page);
  await issuePass(page, org);
  await issuePass(page, org);

  const calls: { path: string; authorization: string | undefined; mode: string | undefined }[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/v1/')) return;
    const headers = r.headers();
    calls.push({ path, authorization: headers.authorization, mode: headers['x-passbook-mode'] });
  });

  await page.goto(`/workbench/o/${org}/passes`);
  await expect(page.getByRole('heading', { level: 1, name: /Passes/ })).toBeVisible();
  const list = page.getByRole('listbox', { name: 'Passes' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(page.getByText('2 passes').first()).toBeVisible();
  // No mode switch, and a sandbox has no On my phone view while the device pass is off.
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Passes view' })).toHaveCount(0);
  await shots(page, 'passes-list');

  // Keyboard: the list takes the arrows, Enter opens the inspector.
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('heading', { level: 2 }).filter({ hasText: /\S/ }).first();
  await expect(inspector).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simulate' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Events', selected: true })).toBeVisible();
  await expect(page.locator('.wb-pass-stage')).toBeVisible();
  // The card needs its fonts and images; the buddy's fall and the deal are over.
  await page.waitForTimeout(1200);
  await shots(page, 'passes-open');

  // `.` opens the Simulate menu; Installed adds a device and an event.
  await page.keyboard.press('.');
  const menu = page.getByRole('menu', { name: 'Simulate' });
  await expect(menu).toBeVisible();
  await shots(page, 'passes-simulate');
  const sent = page.waitForResponse(
    (r) => /\/passes\/[^/]+\/simulate$/.test(r.url()) && r.request().method() === 'POST',
  );
  await menu.getByRole('menuitem', { name: 'Installed' }).click();
  expect((await sent).status()).toBe(201);
  await page.getByRole('tab', { name: 'Devices' }).click();
  await expect(page.getByText(/Simulated/).first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-devices');

  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByText(/installed/i).first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-events');
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible();
  await shots(page, 'passes-versions');
  await page.getByRole('tab', { name: 'Calls' }).click();
  await expect(page.getByRole('link', { name: /All in Logs/ })).toBeVisible();
  await shots(page, 'passes-calls');

  // On my phone: a sandbox pass is a Test preview, its link as a QR.
  await page.getByRole('button', { name: 'Test preview' }).click();
  await expect(page.getByRole('link', { name: 'Open on this phone' })).toBeVisible();
  await shots(page, 'passes-phone');

  // Open in Console hands the operation over by nonce, never a body in the URL.
  await page.getByRole('button', { name: 'Open in Console' }).click();
  await page.getByRole('menuitem', { name: 'Void this pass' }).click();
  await page.waitForURL(/\/console\?op=passes\.postPassesByIdVoid&prefill=/);
  expect(page.url()).not.toMatch(/body/i);
  await page.goBack();

  // Void asks first, then the pass reads Voided.
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  await shots(page, 'passes-void');
  await page.getByRole('button', { name: 'Void pass' }).click();
  await expect(page.getByText('Voided').first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-voided');

  // Every tenant call carried the bearer and no mode header.
  const tenant = calls.filter((c) => /^\/api\/v1\/(passes|request-logs)/.test(c.path));
  expect(tenant.length).toBeGreaterThan(0);
  for (const c of tenant) {
    expect(c.authorization, c.path).toMatch(/^Bearer /);
    expect(c.mode, c.path).toBeUndefined();
  }
});
