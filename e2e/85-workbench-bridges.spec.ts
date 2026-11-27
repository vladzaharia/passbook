import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { readSeed } from './helpers/seed.ts';

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
async function shots(
  page: Page,
  name: string,
  opts: {
    /** The part the state is about, scrolled into view in the window. */
    show?: string;
    /** Puts the state back after a resize (a menu closes on one). */
    prep?: () => Promise<void>;
    /** Still holds after axe has read the page (a menu that closed itself would fail here). */
    keep?: () => Promise<void>;
  } = {},
) {
  if (DIR) mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // A sheet's entrance and the inspector's fade are over before axe reads contrast.
      await page.waitForTimeout(500);
      await opts.prep?.();
      if (opts.show) {
        await page.locator(opts.show).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
        await page.waitForTimeout(250);
      }
      // The shot is of the state as set, before axe walks the page.
      if (DIR && (!only || only.includes(name)))
        await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png` });
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
      await opts.keep?.();
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

const back = (page: Page) => page.getByRole('link', { name: /Back to (admin|Workbench)/ });
const palette = async (page: Page, text: string) => {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+k');
  const input = page.locator('[cmdk-input]');
  await input.fill(text);
  return page.getByRole('option', { name: /Open in Workbench/ });
};

test.describe('admin, Live', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  /** L15: from a Live admin page the Workbench opens that org's Test, never a Live record. */
  test('L15: the sidebar entry opens Test, the way back is named, a tampered return is ignored', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const org = encodeURIComponent(readSeed().org.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/admin/o/${org}/passes`);
    await page.evaluate(() => localStorage.removeItem('passbook-mode'));
    await page.reload();
    const entry = page.getByRole('link', { name: 'Workbench, opens Test' });
    await expect(entry).toBeVisible();
    const href = (await entry.getAttribute('href')) ?? '';
    expect(href).toContain(`/workbench/o/${org}`);
    expect(href).not.toMatch(/live/i);
    expect(href).not.toMatch(/body/i);
    await shots(page, 'bridge-admin-foot', {
      prep: async () => {
        if (!(await entry.isVisible()))
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await expect(entry).toBeVisible();
        // The drawer's slide is over before axe reads contrast.
        await page.waitForTimeout(800);
      },
    });
    await page.goto(`/admin/o/${org}/passes`);
    await entry.click();
    await page.waitForURL((u) => u.pathname.startsWith(`/workbench/o/${org}`));
    // The launch params are taken out of the address once copied.
    await expect(back(page)).toBeVisible();
    await expect.poll(() => page.url()).not.toMatch(/[?&](from|return)=/);
    await expect(back(page)).toHaveAttribute('title', 'Back to admin');
    await back(page).click();
    await page.waitForURL((u) => u.pathname === `/admin/o/${org}/passes`);

    // A tampered return shows no chip, either way.
    for (const bad of ['https://evil.example/admin/', '//evil.example/admin/', '/login']) {
      await page.goto(`/workbench/o/${org}?from=admin&return=${encodeURIComponent(bad)}`);
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`/workbench/o/${org}?from=admin&return=${encodeURIComponent(bad)}`);
      await expect(back(page)).toHaveCount(0);
      await page.goto(`/admin/o/${org}/passes?from=workbench&return=${encodeURIComponent(bad)}`);
      await expect(back(page)).toHaveCount(0);
    }

    // Live: the palette offers no Workbench entries (records never deep-link).
    await page.goto(`/admin/o/${org}/passes`);
    await palette(page, 'workbench');
    await expect(page.getByRole('option', { name: /Open in Workbench/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('arriving from the Workbench adopts Test once, keeps the chip through Live, and goes quiet', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const org = encodeURIComponent(readSeed().org.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/admin/o/${org}/passes`);
    await page.evaluate(() => {
      localStorage.removeItem('passbook-mode');
      sessionStorage.clear();
    });
    const launch = `/admin/o/${org}/passes?mode=test&from=workbench&return=${encodeURIComponent(`/workbench/o/${org}/events`)}`;
    await page.goto(launch);
    await expect(page.getByRole('radio', { name: 'Test' })).toBeChecked();
    const chip = page.getByRole('link', { name: 'Events, Back to Workbench' });
    await expect(chip).toBeVisible();
    await expect.poll(() => page.url()).not.toMatch(/[?&](from|return)=/);
    await shots(page, 'bridge-admin-chip');

    // The palette offers the Workbench's areas in Test.
    const items = await palette(page, 'workbench');
    await expect(items.first()).toBeVisible();
    await shots(page, 'bridge-palette');
    await page.keyboard.press('Escape');

    // Flipping admin to Live keeps the chip (it is navigation) and hides the Workbench entries.
    await page.getByRole('radio', { name: 'Live' }).click();
    await expect(chip).toBeVisible();
    await palette(page, 'workbench');
    await expect(page.getByRole('option', { name: /Open in Workbench/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A lost sessionStorage shows no chip; the sidebar entry remains.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Workbench, opens Test' })).toBeVisible();

    // Three navigations away turn the chip into a quiet "Workbench" link.
    await page.goto(launch);
    await expect(chip).toBeVisible();
    for (const to of ['templates', 'messages', 'settings'])
      await page.locator('nav[aria-label="Admin"]').locator(`a[href$="/${to}"]`).first().click();
    await expect(page.getByRole('link', { name: 'Workbench', exact: true }).first()).toBeVisible();
    await expect(chip).toHaveCount(0);
  });
});

test('a sandbox pass: Open in Workbench with its Test tag, and the way back', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  const org = await sandboxOrgId(page);
  await issuePass(page, org);
  const passId = await page.evaluate(async (o) => {
    const res = await fetch(`/api/v1/passes?orgId=${o}&limit=1`, {
      headers: { 'x-passbook-mode': 'test' },
    });
    return ((await res.json()) as { items: { id: string }[] }).items[0]?.id ?? '';
  }, org);
  expect(passId).not.toBe('');

  await page.goto(`/admin/o/${org}/passes/${passId}`);
  const open = page.getByRole('link', { name: /Open in Workbench/ });
  await expect(open).toBeVisible();
  await expect(open).toContainText('Test');
  expect(await open.getAttribute('href')).toContain(`/workbench/o/${org}/passes`);
  await shots(page, 'bridge-pass-link');

  // A Test key's page carries the link too.
  const keyId = await page.evaluate(async (o) => {
    const res = await fetch(`/api/v1/api-keys?orgId=${o}`, {
      headers: { 'x-passbook-mode': 'test' },
    });
    const body = (await res.json()) as { items?: { id: string; mode?: string }[] };
    return body.items?.find((k) => k.mode === 'test')?.id ?? '';
  }, org);
  if (keyId) {
    await page.goto(`/admin/o/${org}/api-keys/${keyId}`);
    await expect(page.getByRole('link', { name: /Open in Workbench/ })).toBeVisible();
    await shots(page, 'bridge-key-link');
    await page.goto(`/admin/o/${org}/passes/${passId}`);
  }

  await open.click();
  await page.waitForURL((u) => u.pathname === `/workbench/o/${org}/passes`);
  expect(page.url()).toContain(`#${passId}`);
  const chip = page.getByRole('link', { name: 'Pass, Back to admin' });
  await expect(chip).toBeVisible();
  // Arrival focuses the heading; the chip is the first stop after the skip links.
  await page.waitForTimeout(800);
  await shots(page, 'bridge-workbench-chip');
  await chip.click();
  await page.waitForURL((u) => u.pathname === `/admin/o/${org}/passes/${passId}`);

  // Every Workbench call from here carries no Live header.
  const modes: (string | undefined)[] = [];
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname.startsWith('/api/v1/passes') &&
      r.frame().url().includes('/workbench/')
    )
      modes.push(r.headers()['x-passbook-mode']);
  });
  await open.click();
  await page.waitForURL((u) => u.pathname === `/workbench/o/${org}/passes`);
  await expect(page.getByRole('listbox', { name: 'Passes' })).toBeVisible();
  expect(modes.every((m) => m === undefined)).toBe(true);
});
