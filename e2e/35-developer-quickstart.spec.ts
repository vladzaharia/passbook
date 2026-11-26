import { expect, request as playwrightRequest, test } from '@playwright/test';
import { apiAs } from './helpers/api.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The builder gets the one sandbox a person can have, so this spec needs a fresh server (the default). */
test('quickstart: a call from your terminal, the live TEST preview, hear back, done and reset', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubTurnstile(page);
  // The mock provider picks the account by login_hint, as helpers/auth.ts does for the other specs.
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

  // What leaves the page for the funnel: a step name and a problem code, and the page-view time on sandbox create.
  const beacons: Record<string, unknown>[] = [];
  let created: Record<string, unknown> | undefined;
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().endsWith('/developers/beacon')) beacons.push(r.postDataJSON());
    if (r.url().endsWith('/api/v1/developer/sandbox')) created = r.postDataJSON();
  });

  await page.goto('/workbench/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Quickstart' })).toBeVisible();
  // The signed-out page is the whole page: five steps and the empty pass.
  await expect(page.getByRole('listitem').filter({ hasText: 'Hear back' })).toBeVisible();
  await shots(page, 'qs-1-signed-out');

  // Step 1 goes straight to Polaris ID.
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');

  // Step 2: the key decodes once into a .env box, and Copy .env masks it.
  await page.getByRole('button', { name: 'Create sandbox' }).click();
  const env = page.locator('.qs-env-v');
  await expect(env).toContainText(/PASSBOOK_KEY=pbp_test_\S{20,}/);
  await expect(page.getByText('Shown once')).toBeVisible();
  await shots(page, 'qs-2-key');
  await page.getByRole('button', { name: 'Copy .env' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const [, secret = '', templateId = ''] =
    clip.match(/^PASSBOOK_KEY=(\S+)\nPASSBOOK_TEMPLATE_ID=(\S+)\n$/) ?? [];
  expect(secret).toMatch(/^pbp_test_/);
  await expect(env).toContainText(/PASSBOOK_KEY=pbp_test_…[\w-]{4}/);
  await expect(env).not.toContainText(secret);
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 3: curl is the default (no SDK is published) and the page listens for a call from outside it.
  await expect(page.getByRole('tab', { name: 'curl' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Listening for pbp_test_…[\w-]{4}/)).toBeVisible();
  await expect(page.getByText('set -a; . ./.env; set +a')).toBeVisible();
  // An empty key (the shell never exported it) is a 401 the page cannot see: after 45 s it names the causes.
  const anon = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const empty = await anon.post('/api/v1/passes', {
    headers: { authorization: 'Bearer ', 'idempotency-key': 'e2e-empty' },
    data: {},
  });
  await anon.dispose();
  expect(empty.status()).toBe(401);
  await expect(page.getByText('Quiet so far.')).toBeVisible({ timeout: 55_000 });
  await expect(page.getByRole('status', { name: 'Quiet so far.' })).toContainText(
    'The key is not loaded.',
  );
  const api = context.request;
  const auth = { authorization: `Bearer ${secret}`, 'user-agent': 'curl/8.7.1' };
  const template = (await (
    await api.get(`/api/v1/templates/${templateId}`, { headers: auth })
  ).json()) as {
    manifest: { sample: Record<string, unknown> };
  };
  const input = { ...template.manifest.sample, attendee: 'Casey River', ticketId: 'QS-1042' };
  // A bad first line: the page marks it with the problem. The request log redacts a body's input and
  // issues, so the page names the server's own words and the error page, not the missing field.
  const { ticketId: _gone, ...broken } = input;
  const bad = await api.post('/api/v1/passes', {
    headers: { ...auth, 'idempotency-key': 'e2e-bad' },
    data: { templateId, input: broken },
  });
  expect(bad.status()).toBe(422);
  await expect(page.getByText('422 INVALID')).toBeVisible();
  const fix = page.getByRole('alert').filter({ hasText: 'The pass input is invalid.' });
  await expect(fix).toBeVisible();
  await expect(fix.getByRole('link', { name: 'PASS_INPUT_INVALID' })).toBeVisible();

  const made = await api.post('/api/v1/passes', {
    headers: { ...auth, 'idempotency-key': 'e2e-good' },
    data: { templateId, input },
  });
  expect(made.status()).toBe(201);
  await expect(page.getByText('201 CREATED')).toBeVisible();
  await expect(page.getByText('From your terminal').first()).toBeVisible();
  await expect(page.getByText(/curl\/8\.7\.1/).first()).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Your pass, live' });
  await expect(preview.getByText(/Rendered in/)).toBeVisible();
  await shots(page, 'qs-3-pass', true);
  // A sandbox pass is a preview on every channel, and says so.
  await expect(
    preview.getByRole('note').filter({ hasText: 'TEST PREVIEW · NOT INSTALLABLE' }).first(),
  ).toBeAttached();
  await expect(preview.getByRole('link', { name: /\/preview\// })).toBeAttached();
  await expect(preview.getByAltText('QR code of the test preview link')).toBeAttached();

  // A reload keeps the progress: the server holds it, only the key reveal is gone.
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'First call' })).toContainText('Done');
  await expect(page.getByText(/PASSBOOK_KEY=pbp_/)).toHaveCount(0);
  await expect(preview.getByText(/Rendered in/)).toBeAttached();

  // Step 4: change it from the page; the admission on the card changes.
  await page.getByRole('radio', { name: 'VIP' }).click();
  const patch = page.waitForResponse(
    (r) => /\/api\/v1\/passes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Update admission' }).click();
  expect((await patch).status()).toBe(200);
  await expect(page.getByText(/ETag/)).toBeVisible();
  await expect(preview.locator('.pc-value', { hasText: 'VIP' }).first()).toBeAttached();

  // Step 5: the events the sandbox captured, signed.
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.locator('.qs-cap', { hasText: 'webhook.test' })).toContainText('Verified');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /First pass in \d+:\d\d/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Home' })).toBeVisible();
  await shots(page, 'qs-4-done');

  // The key lives in memory for the .env step: not in storage, not in the address.
  const kept = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]),
  );
  expect(kept).not.toMatch(/pbp_(test|live)_/);

  // The funnel carries a step and nothing else; sandbox create carries the page-view time.
  expect(beacons.map((b) => b.step)).toEqual(
    expect.arrayContaining(['sandbox', 'run', 'change', 'home']),
  );
  for (const b of beacons)
    expect(Object.keys(b).every((k) => k === 'step' || k === 'code')).toBe(true);
  expect(Object.keys(created ?? {}).sort()).toEqual(['turnstileToken', 'viewedAt']);

  // "Go to Home" lands on the sandbox's Home in the Workbench, at every width.
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await page.waitForURL((u) => /^\/workbench\/o\/[^/]+$/.test(u.pathname));
  const home = new URL(page.url()).pathname;
  const orgId = home.split('/').at(-1) ?? '';
  for (const [width, height] of [
    [1440, 900],
    [834, 1112],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(home);
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The Sandbox page: Reset deletes the test data through its operation and shows the new key once.
  await page.goto(`/workbench/o/${orgId}/sandbox`);
  await expect(page.getByText(/of \d+/).first()).toBeVisible();
  await shots(page, 'qs-5-sandbox');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(
    page.getByRole('alertdialog').getByText('Passes, events and logs in this sandbox are deleted.'),
  ).toBeVisible();
  await shots(page, 'qs-6-reset-confirm');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset sandbox' }).click();
  await expect(page.getByText(/^pbp_test_\S{20,}$/)).toBeVisible({ timeout: 60_000 });
  expect((await api.get('/api/v1/passes', { headers: auth })).status()).toBe(401);

  // Admin does not list the sandbox; its own URL still opens it, Test only: no Test switch, and
  // the Overview points back here.
  await page.goto('/admin');
  await expect(page.getByText('No organizations')).toBeVisible();
  await page.goto(`/admin/o/${await sandboxOrgId(page)}`);
  await expect(page.getByRole('link', { name: 'Open Developers' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Developers' })).toBeVisible();

  // The platform's funnel card counts it, in numbers only.
  const admin = await apiAs('admin');
  try {
    const funnel = await admin.get('/api/v1/metrics/platform/developer');
    expect(funnel.previewed).toBeGreaterThanOrEqual(1);
    expect(funnel.ttfpSamples).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(funnel)).not.toContain('builder');
  } finally {
    await admin.dispose();
  }
});
