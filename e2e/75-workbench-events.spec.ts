import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { saveState, startOidcAs } from './helpers/auth.ts';
import { readSeed } from './helpers/seed.ts';
import { shots as allShots } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** SHOT_ONLY=a,b takes only those states (a re-shoot after a fix). */
const only = process.env.SHOT_ONLY?.split(',');
const shots = (page: Page, name: string, view = false) =>
  !only || only.includes(name) ? allShots(page, name, view) : Promise.resolve();
/** Serious and critical axe findings on the page as it stands. */
async function serious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    // The bench IdChip's copy label does not start with its visible text (WCAG 2.5.3): bench's, not Events'.
    .disableRules(['label-content-name-mismatch'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** A dialog's entrance and the toast's rise are over before the shot. */
const settle = (page: Page) => page.waitForTimeout(500);

interface Call {
  path: string;
  authorization: string | undefined;
  mode: string | undefined;
}

/**
 * L17 (Workbench v2 §2.3): the Connections wizard, mounted in the Workbench on a member token,
 * creates, pauses and deletes a Test endpoint. Every tenant call it makes carries the bearer and no
 * mode header, and nothing on the page is a Live control. The Live endpoint id answering 404 is
 * the worker test's (`reach.test.ts`). Needs `WALLET_E2E_PREVIEW=1`.
 */
test('L17: the mounted wizard creates, pauses and deletes a Test endpoint', async ({ page }) => {
  test.setTimeout(160_000);
  // Adding an endpoint needs a recent sign-in; a long CI shard's stored session is stale.
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  await saveState(page, 'admin');
  const org = encodeURIComponent(readSeed().org.id);

  const calls: Call[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/v1/')) return;
    const headers = request.headers();
    calls.push({ path, authorization: headers.authorization, mode: headers['x-passbook-mode'] });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/workbench/o/${org}/events?tab=endpoints`);
  await expect(page.getByRole('heading', { level: 1, name: /Events/ })).toBeVisible();
  // The Workbench is Test only: no mode switch anywhere.
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveCount(0);
  await settle(page);
  await shots(page, 'events-empty');
  expect(await serious(page), 'empty Events').toEqual([]);

  // Add endpoint pushes `new=1`, so Back would close the wizard.
  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  await expect(page).toHaveURL(/tab=endpoints&new=1/);
  const wizard = page.getByRole('dialog', { name: 'Add endpoint' });
  await expect(wizard).toBeVisible();
  // An organization has no capture endpoint to pick, and no org chooser.
  await expect(wizard.getByRole('radio', { name: /Capture endpoint/ })).toHaveCount(0);
  const url = `https://hooks.example.com/hooks/e2e-${Date.now()}`;
  await wizard.getByRole('textbox', { name: /^URL/ }).fill(url);
  await wizard.getByRole('textbox', { name: /^URL/ }).blur();
  await settle(page);
  await shots(page, 'events-wizard-destination');
  expect(await serious(page), 'wizard').toEqual([]);
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await settle(page);
  await shots(page, 'events-wizard-review');
  await wizard.getByRole('button', { name: 'Add endpoint' }).click();

  // The signing secret shows once; Done waits for "I saved the secret".
  const done = page.getByRole('dialog', { name: /Set up your server/ });
  await expect(done.getByRole('button', { name: 'Done' })).toBeDisabled();
  await settle(page);
  await shots(page, 'events-wizard-secret');
  await done.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await done.getByRole('button', { name: 'Done' }).click();

  // Finish lands on the endpoint, selected, with Send test event focused.
  await expect(page).toHaveURL(/tab=endpoints#/);
  await expect(page).not.toHaveURL(/new=1/);
  const send = page.getByRole('button', { name: 'Send test event' }).first();
  await expect(send).toBeFocused();
  await expect(page.getByRole('heading', { level: 2, name: /hooks\.example\.com/ })).toBeVisible();
  await shots(page, 'events-endpoint-added');

  // Pause, then delete after the confirm.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await shots(page, 'events-endpoint-delete');
  // Resizing for the shots re-seats the inspector, which closes the question: ask again.
  const ask = page.getByText('Delete this endpoint?');
  if (!(await ask.isVisible())) await page.getByRole('button', { name: 'Delete' }).click();
  await expect(ask).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Endpoint deleted')).toBeVisible();
  await expect(page.getByRole('option', { name: /hooks\.example\.com/ })).toHaveCount(0);

  // Every tenant call rode the Workbench token; none named a mode. (`developer/sandbox` and `developer/home`
  // are the shell's own session reads, which T1 and T8 move onto the token; the boundary test lists them.)
  const tenant = calls.filter(
    ({ path }) =>
      !/^\/api\/v1\/(session|workbench\/(token|contexts)|orgs(\/memberships\/me)?|developer\/(sandbox|home))$/.test(
        path,
      ),
  );
  expect(tenant.length).toBeGreaterThan(3);
  for (const call of calls) expect(call.mode, call.path).toBeUndefined();
  expect(
    tenant.filter((c) => !c.authorization?.startsWith('Bearer pbtry_')).map((c) => c.path),
    'tenant calls without the Workbench token',
  ).toEqual([]);
});

const NOW = Date.now();
const iso = (over: Record<string, unknown> = {}) => ({
  id: 'we-url',
  orgId: 'o',
  mode: 'test',
  url: 'https://hooks.example.com/hooks/orders',
  urlMasked: 'hooks.example.com/…',
  description: 'Orders',
  eventTypes: ['pass.issued', 'pass.scanned'],
  templateIds: null,
  apiVersion: '2026-11-20',
  status: 'active',
  target: 'url',
  failingSince: null,
  disabledAt: null,
  lastSuccessAt: NOW - 60_000,
  lastFailureAt: null,
  lastStatus: 200,
  secretCreatedAt: NOW - 3_600_000,
  previousSecretExpiresAt: null,
  createdAt: NOW - 3_600_000,
  ...over,
});
const envelope = (id: string, type: string, at: number, requestId?: string) => ({
  id,
  type,
  apiVersion: '2026-11-20',
  createdAt: at,
  orgId: 'o',
  mode: 'test',
  pass: { id: 'pass-1111-2222', externalId: 'ORD-7', templateId: 't1' },
  data: type === 'pass.scanned' ? { outcome: 'ok' } : { version: 1 },
  ...(requestId ? { requestId } : {}),
});
const delivery = (endpointId: string, target: string, over: Record<string, unknown> = {}) => ({
  endpointId,
  target,
  eventId: 'ev-2',
  type: 'pass.scanned',
  passId: 'pass-1111-2222',
  externalId: 'ORD-7',
  state: 'delivered',
  attempts: 1,
  nextAt: NOW,
  lastStatus: 200,
  lastError: null,
  lastAttemptAt: NOW - 120_000,
  finishedAt: NOW - 120_000,
  replays: 0,
  ...over,
});
const fulfill = (page: Page, glob: string, body: unknown) =>
  page.route(glob, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: body }) : route.fallback(),
  );

/** The feed and an event's story, from fixtures: the populated states the shots need. */
test('Events: the feed, an event with its deliveries, and a stored request (shots)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  await saveState(page, 'admin');
  const org = encodeURIComponent(readSeed().org.id);
  const capture = iso({
    id: 'we-cap',
    target: 'capture',
    description: '',
    url: 'https://capture.invalid/',
    urlMasked: 'capture.invalid',
  });
  const stored = {
    id: 'cap-1',
    endpointId: 'we-cap',
    eventId: 'ev-2',
    type: 'pass.scanned',
    trigger: 'event',
    status: 200,
    durationMs: 6,
    headers: { 'content-type': 'application/json', 'x-passbook-event-id': 'ev-2' },
    body: JSON.stringify(envelope('ev-2', 'pass.scanned', NOW - 120_000, 'req-abc-123')),
    createdAt: NOW - 120_000,
  };
  await fulfill(page, '**/api/v1/events?*', {
    items: [
      envelope('ev-1', 'pass.issued', NOW - 600_000),
      envelope('ev-2', 'pass.scanned', NOW - 120_000, 'req-abc-123'),
    ],
    nextCursor: 'ev2.AAAAAAAAAAAAAAAAAAAAAA',
    hasMore: false,
  });
  await fulfill(
    page,
    '**/api/v1/events/ev-2?*',
    envelope('ev-2', 'pass.scanned', NOW - 120_000, 'req-abc-123'),
  );
  await fulfill(page, '**/api/v1/events/ev-2/deliveries*', {
    items: [
      delivery('we-url', 'url'),
      delivery('we-cap', 'capture'),
      delivery('we-bad', 'url', { state: 'failed', attempts: 3, lastStatus: 503 }),
    ],
  });
  await fulfill(page, '**/api/v1/webhook-endpoints?*', {
    items: [
      capture,
      iso(),
      iso({ id: 'we-bad', description: 'Staging', urlMasked: 'staging.example.com/…' }),
    ],
    nextCursor: null,
  });
  await fulfill(page, '**/api/v1/webhook-endpoints/we-cap/captures?*', {
    items: [stored],
    nextCursor: null,
  });
  await fulfill(page, '**/api/v1/webhook-endpoints/we-cap/captures/cap-1', stored);
  await page.route('**/api/v1/webhook-endpoints/we-cap/captures/secret', (route) =>
    route.fulfill({ json: { secret: 'whsec_e2e_fixture_secret' } }),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/workbench/o/${org}/events#ev-2`);
  const list = page.getByRole('listbox', { name: 'Events' });
  await expect(list.getByRole('option')).toHaveCount(2);
  // Newest first; the selected event shows where it went.
  await expect(list.getByRole('option').first()).toContainText('pass.scanned');
  const table = page.getByLabel('Deliveries of this event');
  await expect(table.getByText('Capture endpoint')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Console' })).toHaveAttribute(
    'href',
    /\/console\?op=events\.getEventsById&prefill=/,
  );
  await settle(page);
  await shots(page, 'events-feed');
  expect(await serious(page), 'Events feed').toEqual([]);

  // The stored request opens in place, with the signature check.
  await page.goto(`/workbench/o/${org}/events?capture=cap-1#ev-2`);
  const region = page.getByRole('region', { name: 'Captured request' });
  await expect(region.getByRole('tab', { name: 'Verify' })).toBeVisible();
  await expect(region.getByText('Timestamp is not usable')).toBeVisible();
  await settle(page);
  await shots(page, 'events-capture');
  expect(await serious(page), 'stored request').toEqual([]);
});
