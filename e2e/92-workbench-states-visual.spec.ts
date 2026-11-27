import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { wbPath } from '../src/shared/workbench.ts';
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
      await page.screenshot({
        path: `${DIR}/${name}-${width}-${scheme}.png`,
        fullPage: widths !== 'current',
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

const phone = { width: 390, height: 844 };
const h1 = (page: Page) => page.getByRole('main').getByRole('heading', { level: 1 }).first();
const text = (page: Page, value: string | RegExp) => page.getByText(value).first();

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: phone });

  test('a tool shows the one sign-in state', async ({ page }) => {
    await page.goto('/workbench/console');
    await expect(text(page, 'Sign in to use the Workbench')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Polaris ID' }).first()).toBeVisible();
    await shot(page, 'state-signed-out');
  });

  test('Design stays open as the playground', async ({ page }) => {
    await page.goto('/workbench/design');
    await expect(h1(page)).toBeVisible();
    await shot(page, 'state-signed-out-design');
  });
});

test.describe('an account without access', () => {
  test.use({ storageState: 'e2e/.auth/user.json', viewport: phone });

  test('shows one line and the request-access link', async ({ page }) => {
    await page.goto('/workbench');
    await expect(text(page, 'No Workbench access')).toBeVisible();
    await shot(page, 'state-no-access');
  });
});

test.describe('a developer without a sandbox', () => {
  test.use({ storageState: 'e2e/.auth/developer.json', viewport: phone });

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
  test.use({ storageState: 'e2e/.auth/admin.json', viewport: phone });

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
  test.use({ viewport: phone });

  test('the per-tool empty states, and a closed sandbox', async ({ page }) => {
    test.setTimeout(240_000);
    await signInToWorkbench(page, { key: true, desktop: false });
    await page.setViewportSize(phone);
    const org = await sandboxOrgId(page);
    const empties: Array<[string, string | RegExp]> = [
      ['logs', 'Waiting for your first call'],
      ['events', 'Listening for events'],
      ['inbox', 'No test emails'],
      ['passes', 'No passes'],
      ['activity', 'Nothing running'],
      ['keys', 'No API keys'],
      ['design', 'No templates'],
    ];
    for (const [tool, heading] of empties) {
      // The first call and the key list are emptied by the route, so the shot is the §6 empty state
      // whatever the sandbox has already logged or issued.
      const glob = tool === 'logs' ? '**/api/v1/request-logs*' : '**/api/v1/api-keys*';
      const mocked = tool === 'logs' || tool === 'keys';
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
      await shot(page, `empty-${tool}`);
      if (mocked) await page.unroute(glob);
    }
    await page.goto(wbPath(org, 'home'));
    await expect(h1(page)).toBeVisible();
    await shot(page, 'sandbox-home', 'all');

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
