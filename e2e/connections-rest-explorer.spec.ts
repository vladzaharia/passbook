import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { stepUpAdmin } from './helpers/auth.ts';
import { readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

// The probe calls a live host, so the specs answer it with a recorded page; the UI is what is under test.
// Creating a connection needs a recent sign-in, and the stored session ages during a long shard.
const row = (n: number) => ({
  id: `m_${n}`,
  email: `member${n}@example.test`,
  name: `Member ${n}`,
  updated_at: `2026-01-0${n}T10:00:00Z`,
});
const field = (pointer: string, type = 'text') => ({
  pointer,
  jsonPath: `$.data[*]${pointer.replace('/', '.')}`,
  label: pointer.slice(1),
  type,
  samples: ['x'],
});
const sample = (page2: boolean) => ({
  ok: true,
  durationMs: 312,
  request: {
    method: 'GET',
    url: 'https://api.example.test/v1/members',
    status: 200,
    bytes: 48_000,
    contentType: 'application/json',
  },
  headers: {},
  body: {
    data: page2 ? [row(3), row(4)] : [row(1), row(2)],
    meta: { next_cursor: page2 ? null : 'c2', total: 4 },
  },
  pruned: {
    arrays: [{ pointer: '/data', total: 2, shown: 2 }],
    strings: 0,
    depthCut: false,
    nodesCut: false,
  },
  detections: {
    records: [{ pointer: '/data', jsonPath: '$.data[*]', count: 2, score: 0.92, reason: 'name' }],
    pagination: [
      {
        confidence: 'high',
        config: {
          style: 'cursor',
          param: 'cursor',
          cursorPointer: '/meta/next_cursor',
          from: 'body',
        },
        evidence: 'field:/meta/next_cursor',
      },
    ],
    id: [{ pointer: '/id', jsonPath: '$.data[*].id', unique: true, score: 0.95 }],
    updatedAt: [
      { pointer: '/updated_at', jsonPath: '$.data[*].updated_at', format: 'iso', score: 0.9 },
    ],
    holderEmail: [{ pointer: '/email', jsonPath: '$.data[*].email' }],
    fields: [field('/id'), field('/email', 'email'), field('/name'), field('/updated_at', 'date')],
    rateLimit: { limit: 60, windowSeconds: 60 },
  },
  page: page2
    ? { index: 2, from: 3, to: 4, overlap: 0, next: null }
    : { index: 1, from: 1, to: 2, overlap: 0, next: 'tok' },
});

async function answerProbe(page: Page, pattern: string, posts: Record<string, unknown>[] = []) {
  await page.route(pattern, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    await route.fulfill({ json: sample(Boolean(body.next)) });
  });
}

test('connection page: fetch a sample, click through it, prove page 2, save', async ({ page }) => {
  const seed = readSeed();
  await stepUpAdmin(page);
  const api = await apiAs('admin');
  const created = await api.send('POST', '/api/v1/connections', {
    orgId: seed.org.id,
    connectorType: 'http-json',
    name: `E2E REST ${uid('r')}`,
    config: { baseUrl: 'https://api.github.com/v1', list: { path: '/members' } },
    secrets: { token: 'e2e-not-a-real-token' },
  });
  const posts: Record<string, unknown>[] = [];
  await answerProbe(page, '**/api/v1/connections/*/probe', posts);

  await page.goto(
    `/admin/o/${encodeURIComponent(seed.org.id)}/connections/${created.id}?tab=config`,
  );
  await page.getByRole('button', { name: 'Fetch sample' }).click();
  const chips = page.getByRole('group', { name: 'Suggestions' });
  await expect(chips.getByRole('button', { name: /Records.*\/data · 2.*high/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('radio', { name: 'Cursor' })).toBeChecked();
  await expect(page.getByRole('tree', { name: 'Response' })).toBeVisible();
  await expect(page.getByText('Found 2 records')).toBeVisible();
  // Detections applied, then fetched again with them.
  await expect.poll(() => posts.length).toBe(2);
  await shots(page, 'rest-config-sample');

  // Keyboard: the tree takes focus, the arrows walk it, Enter picks.
  await page.getByRole('treeitem', { name: /^email, / }).click();
  await expect(page.getByText('$.data[*].email', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use as holder email' }).click();
  await expect(page.getByLabel('Holder email')).toHaveValue('/email');

  await page.getByRole('button', { name: 'Fetch page 2' }).click();
  await expect(page.getByText(/1–2 · 3–4 · no repeats/)).toBeVisible();
  expect(posts.at(-1)?.next).toBe('tok');
  await shots(page, 'rest-config-page2');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Configuration saved')).toBeVisible();
  const saved = await api.get(`/api/v1/connections/${created.id}`);
  expect(saved.config).toMatchObject({
    holderEmailPointer: '/email',
    list: {
      recordsPointer: '/data',
      pagination: { style: 'cursor', cursorPointer: '/meta/next_cursor' },
    },
  });
  await api.dispose();
});

test('connection page: the platform refusing an address is one line', async ({ page }) => {
  const seed = readSeed();
  await stepUpAdmin(page);
  const api = await apiAs('admin');
  const created = await api.send('POST', '/api/v1/connections', {
    orgId: seed.org.id,
    connectorType: 'http-json',
    name: `E2E REST ${uid('r')}`,
    config: { baseUrl: 'https://api.github.com/v1', list: { path: '/members' } },
    secrets: { token: 'e2e-not-a-real-token' },
  });
  await page.route('**/api/v1/connections/*/probe', (route) =>
    route.fulfill({
      json: {
        ok: false,
        errorCode: 'UNSAFE_URL',
        durationMs: 3,
        request: null,
        headers: {},
        pruned: null,
        detections: null,
        page: null,
      },
    }),
  );
  await page.goto(
    `/admin/o/${encodeURIComponent(seed.org.id)}/connections/${created.id}?tab=config`,
  );
  await page.getByRole('button', { name: 'Fetch sample' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'UNSAFE_URL' });
  await expect(alert).toContainText("PassBook can't call this address. Use a public https URL.");
  await shots(page, 'rest-config-error');
  await api.dispose();
});

test('wizard: fetch a sample on the configuration step and carry its fields to Mapping', async ({
  page,
}) => {
  const seed = readSeed();
  await answerProbe(page, '**/api/v1/connections/probe');
  await page.goto(`/admin/o/${encodeURIComponent(seed.org.id)}/connections/new`);
  await page.getByText('REST API', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel(/^Name/).fill(`E2E REST wizard ${uid('w')}`);
  await page.getByLabel(/Base URL/).fill('https://api.example.test/v1');
  await page.getByLabel('List path').fill('/members');
  await page.getByRole('button', { name: 'Fetch sample' }).click();
  await expect(page.getByRole('tree', { name: 'Response' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Cursor' })).toBeChecked();
  await shots(page, 'rest-wizard-sample');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Template', exact: true }).click();
  await page.getByRole('option', { name: seed.template.name }).click();
  // The sample's fields are matched to the template's, so Mapping opens with rows.
  const rows = page.getByRole('list', { name: 'Mappings' }).getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  await shots(page, 'rest-wizard-mapping');
});

test('connection page: no list is a curious question, and a missing holder email is one line', async ({
  page,
}) => {
  const seed = readSeed();
  await stepUpAdmin(page);
  const api = await apiAs('admin');
  const created = await api.send('POST', '/api/v1/connections', {
    orgId: seed.org.id,
    connectorType: 'http-json',
    name: `E2E REST ${uid('r')}`,
    config: {
      baseUrl: 'https://api.github.com/v1',
      recordPath: '/members/{ref}',
      list: { path: '/members' },
    },
    secrets: { token: 'e2e-not-a-real-token' },
  });
  let noList = true;
  await page.route('**/api/v1/connections/*/probe', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.target === 'record') {
      await route.fulfill({
        json: { ...sample(false), page: null, body: { contact: { mail: 'x' } }, detections: null },
      });
      return;
    }
    const first = sample(false);
    await route.fulfill({
      json: noList ? { ...first, ok: false, errorCode: 'NO_RECORDS', page: null } : first,
    });
  });
  await page.goto(
    `/admin/o/${encodeURIComponent(seed.org.id)}/connections/${created.id}?tab=config`,
  );
  await page.getByRole('button', { name: 'Fetch sample' }).click();
  await expect(page.getByRole('alert')).toContainText('No list at this path.');
  await shots(page, 'rest-config-curious');

  noList = false;
  await page.getByRole('button', { name: 'Fetch again' }).click();
  await page.getByRole('treeitem', { name: /^email, / }).click();
  await page.getByRole('button', { name: 'Use as holder email' }).click();
  await expect(page.getByText('Not on the single record. Pick it there.')).toBeVisible();
  await shots(page, 'rest-config-email-missing');
  await page.getByRole('button', { name: 'Show the record' }).click();
  await expect(page.getByText('Single record', { exact: true })).toBeVisible();
  await shots(page, 'rest-config-record');
  await api.dispose();
});
