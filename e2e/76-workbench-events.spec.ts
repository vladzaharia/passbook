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
 * L17 (Workbench v2 §2.3): Add endpoint in the Workbench opens the one Connections wizard in admin,
 * for the sandbox in Test, with `return=`; the finish comes back to the Workbench with the new
 * endpoint selected, where it is paused and deleted on a member token. The Workbench's own tenant
 * calls carry the bearer and no mode header, and nothing on the page is a Live control. The Live
 * endpoint id answering 404 is the worker test's (`reach.test.ts`). Needs `WALLET_E2E_PREVIEW=1`.
 */
test('L17: Add endpoint runs the admin wizard in Test and returns to the Workbench to pause and delete', async ({
  page,
}) => {
  test.setTimeout(160_000);
  // Adding an endpoint needs a recent sign-in; a long CI shard's stored session is stale.
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  await saveState(page, 'admin');
  const org = encodeURIComponent(readSeed().org.id);

  // Only the Workbench's own calls: the admin wizard rides the session, not the token.
  const calls: Call[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/v1/')) return;
    if (!new URL(request.frame().url()).pathname.startsWith('/workbench/')) return;
    const headers = request.headers();
    calls.push({ path, authorization: headers.authorization, mode: headers['x-passbook-mode'] });
  });

  const events = `/workbench/o/${org}/events?tab=endpoints`;
  const add = () => page.getByRole('link', { name: 'Add endpoint' }).first();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(events);
  await expect(page.getByRole('heading', { level: 1, name: /Events/ })).toBeVisible();
  // The Workbench is Test only: no mode switch anywhere.
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveCount(0);
  await settle(page);
  await shots(page, 'events-empty');
  expect(await serious(page), 'empty Events').toEqual([]);

  // Add endpoint is a link to the admin wizard, in Test, returning here.
  await expect(add()).toHaveAttribute('href', /\/admin\/o\/[^/]+\/connections\/new\?/);
  await expect(add()).toHaveAttribute('href', /source=outbound/);
  await expect(add()).toHaveAttribute('href', /mode=test/);
  await expect(add()).toHaveAttribute('href', /return=%2Fworkbench%2F/);

  // Cancel before anything is created leaves without a question and adds nothing.
  await add().click();
  await page.waitForURL(/\/admin\/o\/[^/]+\/connections\/new\?/);
  await expect(page.getByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
  // A Test organization has no picker, so the first step has no Back; admin is in Test.
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Test' })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForURL(/\/connections(\?|$)/);
  await expect(page.getByRole('dialog', { name: 'Leave setup?' })).toHaveCount(0);

  await page.goto(events);
  await add().click();
  await page.waitForURL(/\/admin\/o\/[^/]+\/connections\/new\?/);
  const url = `https://hooks.example.com/hooks/e2e-${Date.now()}`;
  await page.getByRole('textbox', { name: /URL/ }).fill(url);
  await page.getByRole('textbox', { name: /URL/ }).blur();
  await settle(page);
  await shots(page, 'events-wizard-destination');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  await expect(page.getByRole('heading', { name: 'Choose events', level: 2 })).toBeVisible();
  // Back returns a step; it is not the exit.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
  await next();
  await next();
  await settle(page);
  await shots(page, 'events-wizard-review');
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();

  // The signing secret shows once; Next waits for "I saved the secret".
  await expect(page.getByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await settle(page);
  await shots(page, 'events-wizard-secret');
  await page.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await next();
  await expect(page.getByRole('heading', { name: 'Check the signature', level: 2 })).toBeVisible();
  await next();

  // Done waits for one 2xx; the pinned receiver cannot answer, so stub the test's answer.
  await expect(page.getByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await page.route('**/api/v1/webhook-endpoints/*/test', (route) =>
    route.fulfill({
      json: { ok: true, status: 200, durationMs: 140, errorCode: null, captureId: null },
    }),
  );
  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'hooks.example.com is set up' })).toBeVisible();
  await page.getByRole('button', { name: 'Open endpoint' }).click();

  // The finish returns to the Workbench by hash, with the new endpoint selected.
  await page.waitForURL(/\/workbench\/o\/[^/]+\/events\?tab=endpoints#/);
  await expect(page).not.toHaveURL(/new=1/);
  await expect(page.getByRole('heading', { level: 2, name: /hooks\.example\.com/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveCount(0);
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

  // Every Workbench tenant call rode the token; none named a mode. (`developer/home` and `developer/sandbox`
  // are account-level reads on the session; the boundary test lists them.)
  const tenant = calls.filter(
    ({ path }) =>
      !/^\/api\/v1\/(session|workbench\/(token|contexts)|orgs(\/memberships\/me)?|developer\/(sandbox|home))$/.test(
        path,
      ),
  );
  expect(tenant.length).toBeGreaterThan(3);
  // The account reads (`session`, `orgs/memberships/me`) ride the cookie and carry admin's stored Test mode; the token's calls never name one.
  for (const call of tenant) expect(call.mode, call.path).toBeUndefined();
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
