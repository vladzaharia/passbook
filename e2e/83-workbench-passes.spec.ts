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
  // A track already done (an earlier spec's pass) opens on the Done page, with neither.
  await create
    .or(page.getByRole('radio', { name: 'Run here' }))
    .or(page.locator('.qs-done'))
    .waitFor();
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
  test.setTimeout(600_000);
  await signIn(page);
  const org = await sandboxOrgId(page);
  // Other specs issue passes in this sandbox too: count what is there, then what this spec adds.
  await page.goto(`/workbench/o/${org}/passes`);
  const rows = page.getByRole('listbox', { name: 'Passes' }).getByRole('option');
  await rows.first().or(page.getByText('No passes').first()).waitFor({ timeout: 20_000 });
  const before = await rows.count();
  await issuePass(page, org);
  await issuePass(page, org);
  const total = before + 2;

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
  await expect(list.getByRole('option')).toHaveCount(total);
  await expect(page.getByText(`${total} passes`).first()).toBeVisible();
  // No mode switch. The e2e server has the device pass on, so a sandbox offers the All and On my phone
  // views (the off state is the unit test's: passes-tool.test.tsx).
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveCount(0);
  const views = page.getByRole('radiogroup', { name: 'Passes view' });
  await expect(views.getByRole('radio')).toHaveCount(2);
  await expect(views.getByRole('radio', { name: 'All' })).toBeChecked();
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

  // `.` opens the Simulate menu; Installed adds a device and an event. The layout is settled first:
  // a scroll or a resize closes a menu.
  await page.waitForTimeout(800);
  await page.keyboard.press('.');
  const menu = page.getByRole('menu', { name: 'Simulate' });
  await expect(menu).toBeVisible();
  await shots(page, 'passes-simulate', {
    // A menu is placed when it opens, so each size opens it afresh.
    prep: async () => {
      await page.waitForTimeout(400);
      const trigger = page.getByRole('button', { name: 'Simulate', exact: true });
      if (await menu.isVisible()) await trigger.click();
      await expect(menu).toBeHidden();
      await page.keyboard.press('.');
      await expect(menu).toBeVisible();
    },
    keep: async () => {
      await expect(menu).toBeVisible();
      // On screen: a menu placed outside the window is visible to the DOM and to nobody else.
      const box = await menu.boundingBox();
      const size = page.viewportSize();
      expect(
        box && size && box.y >= 0 && box.y + box.height <= size.height,
        JSON.stringify(box),
      ).toBe(true);
    },
  });
  await page.waitForTimeout(800);
  if (!(await menu.isVisible())) await page.keyboard.press('.');
  await expect(menu).toBeVisible();
  const sent = page.waitForResponse(
    (r) => /\/passes\/[^/]+\/simulate$/.test(r.url()) && r.request().method() === 'POST',
  );
  await menu.getByRole('menuitem', { name: 'Installed', exact: true }).click();
  expect((await sent).status()).toBe(201);
  await page.getByRole('tab', { name: 'Devices' }).click();
  await expect(page.getByText(/Simulated/).first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-devices', { show: '[role=tabpanel]' });

  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByRole('link', { name: 'pass.installed' })).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-events', { show: '[role=tabpanel]' });
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible();
  await shots(page, 'passes-versions');
  await page.getByRole('tab', { name: 'Calls' }).click();
  await expect(page.getByRole('link', { name: /All in Logs/ })).toBeVisible();
  await shots(page, 'passes-calls');

  // On my phone: a sandbox pass is a Test preview, its link as a QR. A resize remounts the
  // inspector between the side pane and the sheet, so each size opens it again.
  const phone = page.getByRole('link', { name: 'Open on this phone' });
  const openPhone = async () => {
    if (!(await phone.isVisible()))
      await page.getByRole('button', { name: 'Test preview' }).click();
    await expect(phone).toBeVisible();
  };
  await openPhone();
  await shots(page, 'passes-phone', { show: 'a:has-text("Open on this phone")', prep: openPhone });

  // Open in Console hands the operation over by nonce, never a body in the URL.
  await page.getByRole('button', { name: 'Open in Console' }).click();
  await page.getByRole('menuitem', { name: 'Void this pass' }).click();
  await page.waitForURL(/\/console\?op=passes\.postPassesByIdVoid&prefill=/);
  expect(page.url()).not.toMatch(/body/i);
  await page.goBack();

  // Void asks first, then the pass reads Voided.
  const ask = page.locator('.wb-pass-void');
  const openAsk = async () => {
    if (!(await ask.isVisible()))
      await page.getByRole('button', { name: 'Void', exact: true }).click();
    await expect(ask).toBeVisible();
  };
  await openAsk();
  await shots(page, 'passes-void', { show: '.wb-pass-void', prep: openAsk });
  await page.waitForTimeout(800);
  await openAsk();
  await page.getByRole('button', { name: 'Void pass' }).click();
  await expect(page.getByText('Voided').first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-voided', { show: '.wb-pass-stage' });

  // Every tenant call carried the bearer and no mode header.
  const tenant = calls.filter((c) => /^\/api\/v1\/(passes|request-logs)/.test(c.path));
  expect(tenant.length).toBeGreaterThan(0);
  for (const c of tenant) {
    expect(c.authorization, c.path).toMatch(/^Bearer /);
    expect(c.mode, c.path).toBeUndefined();
  }

  // An org's On my phone view (the context read as an org's), then the empty list.
  await page.route('**/api/v1/workbench/contexts', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as {
      sandbox: { orgId: string; name: string } | null;
      orgs: unknown[];
    };
    const as = body.sandbox;
    await route.fulfill({
      response: res,
      json: {
        sandbox: null,
        orgs: as ? [{ orgId: as.orgId, name: as.name, slug: 'test-org', tools: ['passes'] }] : [],
      },
    });
  });
  await page.goto(`/workbench/o/${org}/passes?view=phone`);
  await expect(page.getByRole('radio', { name: 'On my phone', checked: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open on this phone' }).first()).toBeVisible({
    timeout: 20_000,
  });
  await shots(page, 'passes-org-phone');

  await page.route('**/api/v1/passes?*', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(`/workbench/o/${org}/passes`);
  await expect(page.getByText('No passes').first()).toBeVisible({ timeout: 20_000 });
  await shots(page, 'passes-empty');
});
