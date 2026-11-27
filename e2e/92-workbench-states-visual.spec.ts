import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { type WbTool, wbPath } from '../src/shared/workbench.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { readSeed } from './helpers/seed.ts';
import { signInToWorkbench } from './helpers/workbench.ts';

/**
 * The design's §6 shared states and the per-tool empty lines, shot at 390 in both themes (plus 834 and
 * 1440 where §6 names them). SHOTS_DIR names the folder; unset, only the assertions run. Needs
 * `WALLET_E2E_PREVIEW=1`.
 */
const DIR = process.env.SHOTS_DIR;
const FULL = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** 'current' shoots the viewport as it is, and as a viewport (not full page): for sheets and their scrim. */
async function shot(page: Page, name: string, widths: 'phone' | 'all' | 'current' = 'phone') {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  // The art's lazy chunks (the lock beside the buddy) arrive after the heading: wait for the network.
  await page.waitForLoadState('networkidle');
  const before = page.viewportSize();
  const views =
    widths === 'all'
      ? FULL
      : widths === 'phone'
        ? FULL.slice(2)
        : [[before?.width ?? 390, before?.height ?? 844] as const];
  for (const [width, height] of views) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(async () => {
        // Art images decode, then every finite animation is taken to its end state.
        await Promise.all(
          [...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))),
        );
        const finite = document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
        for (const a of finite) {
          try {
            a.finish();
          } catch {
            // an animation that cannot finish (paused, or a zero-rate one) is shot as it stands
          }
        }
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      });
      // A full-page capture drops touch emulation on a mobile context, so the viewport is grown to the
      // page's height and shot as a viewport.
      if (widths !== 'current') {
        const full = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.min(Math.max(full, height), 6000) });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
      }
      await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

const phone = { width: 390, height: 844 };
/** The 390 shots are touch-emulated, so the pointer:coarse rules are the ones shot. */
const touch = { viewport: phone, hasTouch: true, isMobile: true };
/** The 834 and 1440 shots: a pointer device, so the pointer:coarse rules stay off. */
const wide = { viewport: phone, hasTouch: false, isMobile: false };
const h1 = (page: Page) => page.getByRole('main').getByRole('heading', { level: 1 }).first();
const text = (page: Page, value: string | RegExp) => page.getByText(value).first();

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] }, ...touch });

  test('a tool shows the one sign-in state', async ({ page }) => {
    await page.goto('/workbench/console');
    await expect(text(page, 'Sign in to use the Workbench')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Polaris ID' }).first()).toBeVisible();
    for (const link of await page.getByRole('link', { name: /^Sign in/ }).all()) {
      if (await link.isVisible())
        expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    await shot(page, 'state-signed-out');
  });

  test('Design stays open as the playground', async ({ page }) => {
    await page.goto('/workbench/design');
    await expect(h1(page)).toBeVisible();
    await shot(page, 'state-signed-out-design');
  });
});

test.describe('an account without access', () => {
  test.use({ storageState: 'e2e/.auth/user.json', ...touch });

  test('shows one line and the request-access link', async ({ page }) => {
    await page.goto('/workbench');
    await expect(text(page, 'No Workbench access')).toBeVisible();
    await shot(page, 'state-no-access');
  });
});

test.describe('a developer without a sandbox', () => {
  test.use({ storageState: 'e2e/.auth/developer.json', ...touch });

  test('offers Create sandbox once', async ({ page }) => {
    await page.route('**/api/v1/workbench/contexts', (route) =>
      route.fulfill({ json: { sandbox: null, orgs: [] } }),
    );
    await page.goto('/workbench');
    await expect(text(page, 'No sandbox yet')).toBeVisible();
    await shot(page, 'state-no-sandbox');
  });
});

test.describe('contexts', () => {
  test.use({ storageState: 'e2e/.auth/admin.json', ...touch });

  const org = () => readSeed().org;
  const tools = ['design', 'passes', 'console', 'logs', 'events', 'inbox', 'activity', 'keys'];

  test('several contexts and none chosen: the chooser', async ({ page }) => {
    await page.route('**/api/v1/workbench/contexts', (route) =>
      route.fulfill({
        json: {
          sandbox: null,
          orgs: [
            { orgId: org().id, name: org().name, slug: org().slug, tools },
            { orgId: 'org-two', name: 'Second org', slug: 'second', tools },
          ],
        },
      }),
    );
    await page.goto('/workbench');
    await expect(text(page, 'Choose a context')).toBeVisible();
    await shot(page, 'state-chooser');
  });

  test('an id that is not theirs: not in your Workbench', async ({ page }) => {
    await page.goto(wbPath('not-an-org', 'home'));
    await expect(text(page, 'Not in your Workbench')).toBeVisible();
    await shot(page, 'state-not-found');
  });

  test('touch: no shortcut hints, 44 px controls', async ({ page }) => {
    await page.goto(wbPath(org().id, 'console'));
    await expect(h1(page)).toBeVisible();
    await expect(page.locator('.btn.run kbd:visible')).toHaveCount(0);
    await shot(page, 'touch-console');
    await page.goto(wbPath(org().id, 'home'));
    await expect(h1(page)).toBeVisible();
    for (const el of await page.getByRole('main').locator('button, a.btn, [role="button"]').all()) {
      if (await el.isVisible())
        expect(
          (await el.boundingBox())?.height ?? 0,
          `${await el.textContent()} is 44 px on touch`,
        ).toBeGreaterThanOrEqual(43.5);
    }
    await shot(page, 'touch-home');
    await page.getByRole('button', { name: /change area/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Workbench' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('kbd:visible')).toHaveCount(0);
    await shot(page, 'touch-nav-sheet', 'current');
    await page.keyboard.press('Escape');
  });

  test('a tool that fails: the line says network, access or server, with Retry', async ({
    page,
  }) => {
    for (const [name, status] of [
      ['failed-server', 500],
      ['failed-access', 403],
    ] as const) {
      await page.route('**/api/v1/request-logs*', (route) =>
        route.fulfill({
          status,
          contentType: 'application/problem+json',
          body: JSON.stringify({ title: 'x', status, code: 'X' }),
        }),
      );
      await page.goto(`/workbench/o/${encodeURIComponent(org().id)}/logs`);
      await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
      expect(
        (await page.getByRole('button', { name: 'Retry' }).first().boundingBox())?.height,
      ).toBeGreaterThanOrEqual(43.5);
      await shot(page, `state-${name}`);
      await page.unroute('**/api/v1/request-logs*');
    }
    await page.route('**/api/v1/request-logs*', (route) => route.abort());
    await page.goto(`/workbench/o/${encodeURIComponent(org().id)}/logs`);
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
    await shot(page, 'state-failed-network');
  });

  test('a session that ended: Sign in again, work kept', async ({ page }) => {
    await page.goto(`/workbench/o/${encodeURIComponent(org().id)}/console`);
    await expect(h1(page)).toBeVisible();
    await page.route('**/api/v1/workbench/token', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'x', status: 401, code: 'UNAUTHENTICATED' }),
      }),
    );
    await page.reload();
    await expect(text(page, 'Your session ended')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again' }).first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shot(page, 'state-session-expired');
  });
});

test.describe('a developer sandbox', () => {
  test.use({ ...touch });

  test('the per-tool empty states, and a closed sandbox', async ({ page }) => {
    test.setTimeout(240_000);
    await signInToWorkbench(page, { key: true, desktop: false });
    await page.setViewportSize(phone);
    const org = await sandboxOrgId(page);
    const empties: Array<[WbTool, string | RegExp]> = [
      ['logs', 'Waiting for your first call'],
      ['events', 'Listening for events'],
      ['inbox', 'No test emails'],
      ['passes', 'No passes'],
      ['activity', 'Nothing running'],
      ['keys', 'No keys'],
      ['design', 'No templates'],
    ];
    for (const [tool, heading] of empties) {
      // The first call, the key list and the templates are emptied by the route, so the shot is the §6
      // empty state whatever the sandbox has already logged, issued or made.
      const globs = { logs: '**/api/v1/request-logs*', design: '**/api/v1/templates?*' };
      const glob = globs[tool as keyof typeof globs] ?? '**/api/v1/api-keys*';
      const mocked = tool === 'logs' || tool === 'keys' || tool === 'design';
      if (mocked)
        await page.route(glob, (route) =>
          route.request().method() === 'GET' && !/api-keys\/[^/?]/.test(route.request().url())
            ? route.fulfill({
                json: { items: [], nextCursor: null, capped: null, bodiesRecorded: true },
              })
            : route.fallback(),
        );
      await page.goto(wbPath(org, tool));
      await expect(h1(page)).toBeVisible();
      await expect(text(page, heading)).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      if (tool === 'passes') {
        const radios = page.getByRole('radio');
        expect(await radios.count()).toBeGreaterThan(1);
        for (const radio of await radios.all())
          expect((await radio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      }
      await shot(page, `empty-${tool}`);
      if (mocked) await page.unroute(glob);
    }

    await page.route('**/api/v1/workbench/contexts', async (route) => {
      const real = (await (await route.fetch()).json()) as {
        sandbox: Record<string, unknown> | null;
      };
      await route.fulfill({
        json: { ...real, sandbox: real.sandbox && { ...real.sandbox, closed: true } },
      });
    });
    await page.goto(wbPath(org, 'home'));
    await expect(h1(page)).toBeVisible();
    await shot(page, 'state-sandbox-closed');
  });
});

test.describe('wide shots', () => {
  test.use({ storageState: 'e2e/.auth/admin.json', ...wide });

  const org = () => readSeed().org;
  const tools = ['design', 'passes', 'console', 'logs', 'events', 'inbox', 'activity', 'keys'];

  test('a tool the org has not got: Not available, the nearest tool and Open in admin', async ({
    page,
  }) => {
    await page.route('**/api/v1/workbench/contexts', (route) =>
      route.fulfill({
        json: {
          sandbox: null,
          orgs: [
            {
              orgId: org().id,
              name: org().name,
              slug: org().slug,
              tools: tools.filter((t) => t !== 'keys'),
            },
          ],
        },
      }),
    );
    await page.goto(`/workbench/o/${encodeURIComponent(org().id)}/keys`);
    await expect(text(page, /Not available in .* Test mode/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open in admin' }).first()).toBeVisible();
    await shot(page, 'state-tool-not-allowed', 'all');
  });

  test('an org Test: home, and the nav sheet', async ({ page }) => {
    await page.goto(wbPath(org().id, 'home'));
    await expect(h1(page)).toBeVisible();
    await shot(page, 'org-test-home', 'all');
    for (const [width, height] of FULL.slice(1)) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: /change area/ }).click();
      await expect(page.getByRole('dialog', { name: 'Workbench' })).toBeVisible();
      await shot(page, `nav-sheet-${width}`, 'current');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('a developer sandbox, wide', () => {
  test.use({ ...wide });

  test('the sandbox home', async ({ page }) => {
    test.setTimeout(240_000);
    await signInToWorkbench(page, { key: true, desktop: false });
    await page.setViewportSize(phone);
    const org = await sandboxOrgId(page);
    await page.goto(wbPath(org, 'home'));
    await expect(h1(page)).toBeVisible();
    await shot(page, 'sandbox-home', 'all');
  });
});
