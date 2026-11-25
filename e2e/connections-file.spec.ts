import { expect, test } from '@playwright/test';
import { apiAs, requireActiveTemplateRelease, seedTemplateId, uid } from './helpers/api.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { addOrgMember, readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(360_000);

const csv = (rows: string[][]) =>
  ['Member ID,Name,Email', ...rows.map((r) => r.join(','))].join('\n');
const file = (name: string, text: string) => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(text),
});

test('file upload: create from a CSV, sync, upload a new version, review the removals, apply', async ({
  page,
  browser,
}) => {
  const seed = readSeed();
  const api = await apiAs('admin');
  await requireActiveTemplateRelease(api, seed.org.id, seedTemplateId(), 'live');
  const tag = uid('fu');
  const name = `E2E File ${tag}`;
  const row = (n: number, who: string) => [
    `${tag}-${n}`,
    who,
    `${who.toLowerCase()}.${tag}@example.test`,
  ];
  const v1 = csv([row(1, 'Maya'), row(2, 'Noor'), row(3, 'Ola')]);
  const v2 = csv([row(1, 'Maya R'), row(2, 'Noor'), row(4, 'Pia')]);

  const inOrg = `/admin/o/${encodeURIComponent(seed.org.id)}`;
  await page.goto(`${inOrg}/connections/new`);
  await page.getByText('File upload', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  const drop = page.getByLabel('Drop a file or choose');
  await expect(drop).toBeAttached();
  await shots(page, 'file-wizard-empty');

  // Errors first: a file the parser refuses (an old .xls), then the real file.
  await drop.setInputFiles({
    name: 'old.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  });
  await expect(page.getByText(/Save the sheet as \.xlsx or CSV/)).toBeVisible();
  await shots(page, 'file-wizard-bad-file');
  await drop.setInputFiles({
    name: 'big.csv',
    mimeType: 'text/csv',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 'a'),
  });
  await expect(page.getByText('Over 5 MB. Remove columns or split the file.')).toBeVisible();
  await shots(page, 'file-wizard-too-large');

  await drop.setInputFiles(file('members.csv', v1));
  await expect(page.getByText('3 rows read')).toBeVisible();
  await expect(page.getByText('Every row has a unique ID')).toBeVisible();
  await page.getByLabel(/^Name/).fill(name);
  await shots(page, 'file-wizard-preview');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('combobox', { name: 'Template', exact: true }).click();
  await page.getByRole('option', { name: seed.template.name }).click();
  const mappings: [string, string][] = [
    ['Name *', 'Name'],
    ['ID *', 'Member ID'],
  ];
  for (const [i, [field, from]] of mappings.entries()) {
    await page.getByRole('button', { name: 'Add mapping' }).click();
    const item = page.getByRole('list', { name: 'Mappings' }).getByRole('listitem').nth(i);
    await item.getByRole('combobox', { name: 'Source field' }).click();
    await page.getByRole('option', { name: from, exact: true }).click();
    await item.getByRole('combobox', { name: 'Template field' }).click();
    await page.getByRole('option', { name: field, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText('Syncs when you apply a file.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Poll' })).toHaveCount(0);
  await page.getByLabel('Holder email', { exact: true }).fill('/Email');
  await page.getByRole('checkbox', { name: 'Create passes for new records' }).check();
  await shots(page, 'file-wizard-lifecycle');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith(`${inOrg}/connections/`));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Create applied the first file: the page opens Applying, then Applied.
  const id = new URL(page.url()).pathname.split('/').pop() as string;
  const passes = `/api/v1/passes?orgId=${encodeURIComponent(seed.org.id)}&connectionId=${encodeURIComponent(id)}`;
  await expect.poll(async () => (await api.get(passes)).items.length, { timeout: 60_000 }).toBe(3);
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await shots(page, 'file-detail-applied');

  // A new version: one row changed, one new, one gone. Nothing happens until Apply.
  await page.getByLabel('Drop a file or choose').setInputFiles(file('members-v2.csv', v2));
  await expect(page.getByText('New version · members-v2.csv')).toBeVisible();
  await expect(page.getByText('1 row is not in the file')).toBeVisible();
  await expect(page.getByText('Their passes will be flagged for review.')).toBeVisible();
  await expect(page.getByText(`${tag}-3`, { exact: true })).toBeVisible();
  await shots(page, 'file-detail-pending');
  expect((await api.get(passes)).items.length).toBe(3);

  // The same File tab in Test mode, and for a viewer who cannot manage connections.
  await page.getByRole('radio', { name: 'Test' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Test mode' })).toBeVisible();
  // Stored connections have no Test environment: the page says so, and Switch to Live is the way back.
  await expect(page.getByText('Connections run in Live.')).toBeVisible();
  await expect(page.getByText('Connection not found')).toHaveCount(0);
  await shots(page, 'live-only-test-detail');
  await page.goto(`${inOrg}/connections`);
  await expect(page.getByText('Connections run in Live.')).toBeVisible();
  await shots(page, 'live-only-test-list');
  await page.getByRole('button', { name: 'Switch to Live' }).click();
  await expect(page.getByText('Connections run in Live.')).toHaveCount(0);
  await page.goto(`${inOrg}/connections/${id}`);
  const user = await apiAs('user');
  await addOrgMember(api, seed.org.id, user, ['read_only']);
  const viewer = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
  const vp = await viewer.newPage();
  await vp.goto(`${inOrg}/connections/${id}`);
  await expect(vp.getByText('New version · members-v2.csv')).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  await expect(vp.getByText('Upload new version')).toHaveCount(0);
  await shots(vp, 'file-tab-viewer');
  await viewer.close();

  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(
      async () => {
        const list = await api.get(`/api/v1/connections/${id}/files`);
        return list.items[0]?.applied === true && list.items[0]?.revision === 2;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(page.getByText('New version · members-v2.csv')).toHaveCount(0);
  await expect(page.getByText('Revision 2')).toBeVisible();
  await expect(page.getByText('Revision 1')).toBeVisible();
  await shots(page, 'file-detail-history');

  // The run still going, as a slow sync shows it: the card and the history row both say Applying.
  await page.route(`**/api/v1/connections/${id}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const run = { ...body.runs[0], outcome: 'running', finishedAt: null, startedAt: Date.now() };
    await route.fulfill({ response: res, json: { ...body, runs: [run, ...body.runs] } });
  });
  await page.route(`**/api/v1/connections/${id}/files**`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const r of body.items) if (r.revision === 2) r.applied = false;
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(page.getByText('Applying', { exact: true })).toHaveCount(2);
  await shots(page, 'file-detail-history-applying');
  await page.unroute(`**/api/v1/connections/${id}`);
  await page.unroute(`**/api/v1/connections/${id}/files**`);
  const list = (await api.get(passes)).items as unknown[];
  expect(list.length).toBe(4);

  // Same bytes again: nothing is made.
  await page.getByLabel('Drop a file or choose').setInputFiles(file('members-v2.csv', v2));
  await expect(page.getByText('No changes. The file matches the current version.')).toBeVisible();
});

test('file upload: a rate limit reads as a wait, not a failure', async ({ page }) => {
  const seed = readSeed();
  await page.route('**/api/v1/connections/uploads**', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'content-type': 'application/problem+json', 'retry-after': '1500' },
      body: JSON.stringify({
        type: 'about:blank#RATE_LIMITED',
        title: 'RATE_LIMITED',
        status: 429,
        code: 'RATE_LIMITED',
        detail: 'Too many uploads this hour. Try again later.',
      }),
    }),
  );
  await page.goto(`/admin/o/${encodeURIComponent(seed.org.id)}/connections/new`);
  await page.getByText('File upload', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page
    .getByLabel('Drop a file or choose')
    .setInputFiles(file('members.csv', csv([['a', 'b', 'c@example.test']])));
  await expect(page.getByText('Too many uploads this hour. Try again in 25 min.')).toBeVisible();
  await shots(page, 'file-wizard-rate-limited');
});

test('file upload: a JSON file picks its records and ID from the tree', async ({ page }) => {
  const seed = readSeed();
  const doc = {
    meta: { total: 2 },
    members: [
      { number: 'A-1', person: { name: 'Maya' }, email: 'maya@example.test' },
      { number: 'A-2', person: { name: 'Noor' }, email: 'noor@example.test' },
    ],
  };
  await page.goto(`/admin/o/${encodeURIComponent(seed.org.id)}/connections/new`);
  await page.getByText('File upload', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Drop a file or choose').setInputFiles({
    name: 'members.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByText('2 rows read')).toBeVisible();
  const tree = page.getByRole('tree', { name: 'JSON file' });
  await expect(tree).toBeVisible();
  await tree.getByText('"A-1"').click();
  await page.getByRole('button', { name: 'Use as ID' }).click();
  await expect(page.getByLabel(/ID column/)).toContainText('number');
  await shots(page, 'file-wizard-json');
});

test('a developer sandbox has no Connections: hidden from the nav, a direct URL says Live only', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/developer.json' });
  const page = await ctx.newPage();
  const dev = await apiAs('developer');
  const made = await dev.get('/api/v1/developer/sandbox');
  if (!made.sandbox)
    await dev.send('POST', '/api/v1/developer/sandbox', {
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
    });
  await page.goto('/');
  const orgId = await sandboxOrgId(page);
  await page.goto(`/admin/o/${encodeURIComponent(orgId)}`);
  const nav = page.getByRole('navigation', { name: 'Admin' });
  await expect(nav.getByRole('link', { name: 'Passes' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Connections' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Webhooks' })).toBeVisible();
  await shots(page, 'live-only-sandbox-nav');
  // On a phone the nav is in the menu: open it for the 390 shots.
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(nav.getByRole('link', { name: 'Webhooks' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${dir}/live-only-sandbox-nav-menu-390-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await nav.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page.getByRole('tab', { name: 'Webhook endpoints', selected: true })).toBeVisible();
  await page.goto(`/admin/o/${encodeURIComponent(orgId)}/connections/${'c'.repeat(26)}`);
  await expect(page.getByText('Connections run in Live.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to Live' })).toHaveCount(0);
  await shots(page, 'live-only-sandbox-detail');
  await page.goto(`/admin/o/${encodeURIComponent(orgId)}/connections`);
  await expect(page.getByText('Connections run in Live.')).toBeVisible();
  await shots(page, 'live-only-sandbox-list');
  await ctx.close();
});
