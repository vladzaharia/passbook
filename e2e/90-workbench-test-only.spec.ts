import { expect, type Page, test } from '@playwright/test';
import { type WbTool, wbPath } from '../src/shared/workbench.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { readSeed } from './helpers/seed.ts';
import { signInToWorkbench } from './helpers/workbench.ts';

/**
 * The Workbench is Test only (design L14, L16, L19). Needs the prerendered portal: `WALLET_E2E_PREVIEW=1`.
 * L15 is e2e 85, L17 is e2e 76, L20 is e2e 86.
 */
const ORG_TOOLS = [
  'home',
  'design',
  'passes',
  'console',
  'logs',
  'events',
  'inbox',
  'activity',
  'keys',
] as const;
const SANDBOX_TOOLS = [...ORG_TOOLS, 'sandbox'] as const;

interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
}

/** Records every API call a Workbench page makes, with all its headers. */
function recordCalls(page: Page) {
  const pending: Promise<Call>[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/v1/')) return;
    if (!new URL(request.frame().url()).pathname.startsWith('/workbench/')) return;
    pending.push(
      request.allHeaders().then((headers) => ({
        path: url.pathname,
        method: request.method(),
        headers,
      })),
    );
  });
  return () => Promise.all(pending);
}

/** The account-level reads that ride the session: everything else is a tenant call on the token. */
const ACCOUNT_READ =
  /^\/api\/v1\/(session|workbench\/(token|contexts)|orgs(\/memberships\/me)?|developer\/(sandbox|home))$/;

/** Every URL the page shows, checked as it appears: no body in a Workbench address (L19). */
function watchUrls(page: Page) {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url());
  });
  return seen;
}

async function walk(page: Page, org: string, tools: readonly WbTool[]) {
  const finish = recordCalls(page);
  const urls = watchUrls(page);
  for (const tool of tools) {
    await page.goto(wbPath(org, tool));
    await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    // No Live control anywhere in the Workbench.
    await expect(page.getByRole('radio', { name: 'Live' }), tool).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Live$/ }), tool).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Live$/ }), tool).toHaveCount(0);
  }
  const calls = await finish();
  const tenant = calls.filter((c) => !ACCOUNT_READ.test(c.path));
  expect(tenant.length, 'tenant calls seen').toBeGreaterThan(tools.length);
  // The token is bound to the session cookie (`same-origin`), so the cookie rides along; what must never happen is a call without the bearer.
  for (const c of tenant) {
    expect(c.headers.authorization ?? '', `${c.method} ${c.path} bearer`).toMatch(/^Bearer pbtry_/);
    expect(c.headers['x-passbook-mode'], `${c.method} ${c.path} mode`).toBeUndefined();
  }
  for (const url of urls) {
    const { search } = new URL(url);
    expect(new URLSearchParams(search).has('body'), url).toBe(false);
    expect(decodeURIComponent(search), url).not.toMatch(/[{}]/);
  }
}

test.describe('a developer sandbox', () => {
  test('L14: every tool calls the API with the token alone, names no mode and has no Live control', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await signInToWorkbench(page, { key: true });
    await walk(page, await sandboxOrgId(page), SANDBOX_TOOLS);
  });
});

test.describe('an org Test', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('L14: every tool calls the API with the token alone, names no mode and has no Live control', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await walk(page, encodeURIComponent(readSeed().org.id), ORG_TOOLS);
  });

  test('L16: a Console run the token may not make shows WORKBENCH_TEST_ONLY with its error-page link', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The Console keeps a locked operation from running; the server must hold the line when the client does not.
    let locked = '';
    await page.route('**/developers/run/index.json', async (route) => {
      const index = (await (await route.fetch()).json()) as {
        groups: { items: { id: string; method: string; wb: boolean }[] }[];
      };
      const item = index.groups.flatMap((g) => g.items).find((i) => !i.wb && i.method === 'get');
      if (!item) throw new Error('Every operation is allowlisted.');
      locked = item.id;
      item.wb = true;
      await route.fulfill({ json: index });
    });
    await page.goto(`/workbench/o/${encodeURIComponent(readSeed().org.id)}/console`);
    await expect(page.getByRole('heading', { level: 1, name: 'Console' })).toBeVisible();
    await expect.poll(() => locked).not.toBe('');
    await page.goto(
      `/workbench/o/${encodeURIComponent(readSeed().org.id)}/console?op=${encodeURIComponent(locked)}`,
    );
    const run = page.getByRole('button', { name: /^Run/ }).first();
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.locator('.stamp')).toContainText(/^403/);
    await expect(page.getByText('WORKBENCH_TEST_ONLY').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'WORKBENCH_TEST_ONLY' }).first()).toHaveAttribute(
      'href',
      /\/developers\/errors.*WORKBENCH_TEST_ONLY|WORKBENCH_TEST_ONLY/i,
    );
  });
});
