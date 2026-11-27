import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { signInToWorkbench } from './helpers/workbench.ts';

/** SHOT_ONLY=a,b takes only those states (a re-shoot after a fix). SHOTS_DIR names the folder; unset, a no-op. */
const only = process.env.SHOT_ONLY?.split(',');
const DIR = process.env.SHOTS_DIR;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;
/** Every width and theme of a state: the window at 1440 and 834 (the index and the stage scroll apart), the whole page at 390. */
async function shots(page: Page, name: string, show?: string) {
  if (DIR) mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      // The window shows the part the state is about: the response sits below the form.
      if (show) await page.locator(show).first().scrollIntoViewIfNeeded();
      // Every state, every width, both themes: nothing serious or critical.
      const found = (await new AxeBuilder({ page }).analyze()).violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      );
      expect(
        found.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        `${name} ${width} ${scheme}`,
      ).toEqual([]);
      if (!DIR || (only && !only.includes(name))) continue;
      await page.screenshot({
        path: `${DIR}/${name}-${width}-${scheme}.png`,
        fullPage: width === 390,
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

const signIn = (page: Page) => signInToWorkbench(page, { key: true, desktop: false });

interface IndexItem {
  id: string;
  method: string;
  path: string;
  wb: boolean;
}
/** An operation of the docs' index, by method and path. */
async function op(page: Page, method: string, path: string): Promise<IndexItem> {
  const index = await page.evaluate(async () => {
    const res = await fetch('/developers/run/index.json');
    return (await res.json()) as { groups: { items: IndexItem[] }[] };
  });
  const found = index.groups
    .flatMap((g) => g.items)
    .find((i) => i.method === method && i.path === path);
  if (!found) throw new Error(`No operation ${method} ${path}`);
  return found;
}

async function open(page: Page, query: string): Promise<string> {
  const org = await sandboxOrgId(page);
  await page.goto(`/workbench/o/${org}/console${query}`);
  return org;
}

test('the Console: never runs on arrival, runs on Cmd+Enter with the token, and its request id opens Logs', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/passes'))
      calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const list = await op(page, 'get', '/api/v1/passes');
  const org = await open(page, `?op=${encodeURIComponent(list.id)}`);
  const index = page.getByRole('listbox', { name: 'Operations' });
  await expect(index).toBeVisible();
  await expect(page.getByText(/^\d+ operations$/)).toBeVisible();
  await expect(index.getByRole('option', { selected: true })).toContainText('GET');
  await page.waitForLoadState('networkidle');
  expect(calls).toEqual([]);
  await shots(page, 'console-idle');

  // With no operation in the address it opens on a read, and says so in the address.
  await open(page, '');
  await expect(page).toHaveURL(/console\?op=/);

  await open(page, `?op=${encodeURIComponent(list.id)}`);
  await expect(page.getByRole('button', { name: /^Run/ })).toBeEnabled();
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/passes');
  await page.keyboard.press('Control+Enter');
  const request = await sent;
  expect(await request.headerValue('authorization')).toMatch(/^Bearer /);
  expect(await request.headerValue('x-passbook-mode')).toBeNull();
  await expect(page.locator('.stamp')).toContainText(/^2\d\d/);
  const rid = await page.locator('.cr-h .bench-id-c').getAttribute('title');
  expect(rid).toBeTruthy();
  await shots(page, 'console-response', '.cr-h');
  await page.getByRole('link', { name: 'View in Logs' }).click();
  await page.waitForURL(new RegExp(`/workbench/o/${org}/logs`));
  expect(decodeURIComponent(new URL(page.url()).hash.slice(1))).toBe(rid);
});

test('the Console: SDK, curl and CLI lines carry $PASSBOOK_KEY and never the token', async ({
  page,
}) => {
  await signIn(page);
  const create = await op(page, 'post', '/api/v1/passes');
  await open(page, `?op=${encodeURIComponent(create.id)}`);
  for (const name of ['curl', 'TypeScript', 'Python', 'Go', 'CLI']) {
    await page.getByRole('tab', { name }).click();
    const code = (await page.getByRole('tabpanel').textContent()) ?? '';
    expect(code, name).not.toMatch(/pbtry_|Bearer [A-Za-z0-9_.-]{20,}/);
    if (name !== 'CLI') expect(code, name).toContain('PASSBOOK_KEY');
    if (name === 'TypeScript') await shots(page, 'console-lines');
  }
});

test('the Console: a destructive call asks first, and a handoff fills the form without a body in the URL', async ({
  page,
}) => {
  await signIn(page);
  const remove = await op(page, 'delete', '/api/v1/webhook-endpoints/{id}');
  await open(page, `?op=${encodeURIComponent(remove.id)}`);
  await page.getByLabel(/^id/).fill('00000000-0000-7000-8000-000000000000');
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE') sent.push(r.url());
  });
  await page.getByRole('button', { name: 'Run' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await shots(page, 'console-confirm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toEqual([]);

  const create = await op(page, 'post', '/api/v1/passes');
  await page.evaluate(
    (id) =>
      sessionStorage.setItem(
        'wb-prefill:e2e1',
        JSON.stringify({ op: id, body: { templateId: 'from-a-pass' } }),
      ),
    create.id,
  );
  await open(page, `?op=${encodeURIComponent(create.id)}&prefill=e2e1`);
  await expect(page.getByLabel('Request body (JSON)')).toHaveValue(/from-a-pass/);
  expect(page.url()).not.toContain('from-a-pass');
  expect(await page.evaluate(() => sessionStorage.getItem('wb-prefill:e2e1'))).toBeNull();
  await shots(page, 'console-handoff');
});

test('the Console: a failed call is a sorry with the first issue; an org Test locks what a member token cannot call', async ({
  page,
}) => {
  await signIn(page);
  const create = await op(page, 'post', '/api/v1/passes');
  await open(page, `?op=${encodeURIComponent(create.id)}`);
  await page.getByRole('tab', { name: 'JSON' }).click();
  await page.getByLabel('Request body (JSON)').fill('{"templateId":"nope","input":{}}');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.stamp')).toContainText(/^4\d\d/);
  await expect(page.locator('.cr-cheer .wl-buddy[data-scene="sorry"]')).toBeVisible();
  await page.waitForTimeout(600);
  await shots(page, 'console-sorry', '.cr-h');

  // The sandbox as an org's Test: only the allowlisted operations run on a member token.
  const org = await sandboxOrgId(page);
  await page.route('**/api/v1/workbench/contexts', async (route) => {
    const real = (await (await route.fetch()).json()) as {
      sandbox: { orgId: string; name: string } | null;
    };
    await route.fulfill({
      json: {
        sandbox: null,
        orgs: [
          {
            orgId: org,
            name: real.sandbox?.name ?? 'Test',
            slug: 'test',
            tools: ['design', 'passes', 'console', 'logs', 'events', 'inbox', 'activity', 'keys'],
          },
        ],
      },
    });
  });
  const index = await page.evaluate(async () => {
    const res = await fetch('/developers/run/index.json');
    return (await res.json()) as { groups: { items: IndexItem[] }[] };
  });
  const locked = index.groups.flatMap((g) => g.items).find((i) => !i.wb && i.method === 'get');
  if (!locked) throw new Error('Every operation is allowlisted.');
  await page.goto(`/workbench/o/${org}/console?op=${encodeURIComponent(locked.id)}`);
  await expect(page.getByRole('button', { name: /^Run/ })).toBeDisabled();
  await expect(page.getByText(/Not available in Test/).first()).toBeVisible();
  await shots(page, 'console-locked');
});

test('the Console: the JSON editor numbers each line once, and the index sheet opens below 1180', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const create = await op(page, 'post', '/api/v1/passes');
  await open(page, `?op=${encodeURIComponent(create.id)}`);
  await page.waitForLoadState('networkidle');
  const trigger = page.getByRole('button', { name: /Operation/ });
  await expect(trigger).toBeVisible();
  await page.getByRole('tab', { name: 'JSON' }).click();
  const lines = await page.locator('.editor pre .ln').count();
  const value = await page.getByLabel('Request body (JSON)').inputValue();
  expect(lines).toBe(value.split('\n').length);
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Operations' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(500);
  const inUse = await sheet.getByRole('option', { selected: true }).boundingBox();
  const frame = await sheet.locator('.bench-sheet-b').boundingBox();
  expect(inUse && frame).toBeTruthy();
  if (inUse && frame) {
    expect(inUse.y).toBeGreaterThanOrEqual(frame.y - 1);
    expect(inUse.y + inUse.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  }
  if (process.env.SHOTS_DIR && (!only || only.includes('console-index-sheet')))
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: `${process.env.SHOTS_DIR}/console-index-sheet-390-${scheme}.png`,
      });
    }
  await sheet
    .getByRole('option', { name: /List passes/ })
    .first()
    .click();
  await expect(sheet).toBeHidden();
  expect(new URL(page.url()).searchParams.get('op')).toContain('passes');
});

test('the Console: a search with no match says so, and Clear brings the index back', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '');
  const index = page.getByRole('listbox', { name: 'Operations' });
  await expect(index).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find an operation' }).fill('zzzzzz');
  await expect(page.getByText(/^No operations match/)).toBeVisible();
  await expect(index).toBeHidden();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(index).toBeVisible();
});
