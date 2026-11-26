import { expect, request as playwrightRequest, test } from '@playwright/test';
import { apiAs } from './helpers/api.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
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

  await page.goto('/developers/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your first pass' })).toBeVisible();
  // The signed-out page is the whole page: five steps and the empty pass.
  await expect(page.getByRole('listitem').filter({ hasText: 'Hear back' })).toBeVisible();

  // Step 1 goes straight to Polaris ID.
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');

  // Step 2: the key decodes once into a .env box, and Copy .env masks it.
  await page.getByRole('button', { name: 'Create sandbox' }).click();
  const env = page.locator('.qs-env-v');
  await expect(env).toContainText(/PASSBOOK_KEY=pbp_test_\S{20,}/);
  await expect(page.getByText('Shown once')).toBeVisible();
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
  // A bad first line: the page marks it with the problem and the field to change.
  const { ticketId: _gone, ...broken } = input;
  const bad = await api.post('/api/v1/passes', {
    headers: { ...auth, 'idempotency-key': 'e2e-bad' },
    data: { templateId, input: broken },
  });
  expect(bad.status()).toBe(422);
  await expect(page.getByText('422 INVALID')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'ticketId is required.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '"ticketId": "QS-1042"' })).toBeVisible();

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
  // A sandbox pass is a preview on every channel, and says so.
  await expect(
    // Each face of the card carries the band.
    preview.getByRole('note').filter({ hasText: 'TEST PREVIEW · NOT INSTALLABLE' }).first(),
  ).toBeVisible();
  await expect(preview.getByRole('link', { name: /\/preview\// })).toBeVisible();
  await expect(preview.getByAltText('QR code of the test preview link')).toBeVisible();

  // A reload keeps the progress: the server holds it, only the key reveal is gone.
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'First call' })).toContainText('Done');
  await expect(page.getByText(/PASSBOOK_KEY=pbp_/)).toHaveCount(0);
  await expect(preview.getByText(/Rendered in/)).toBeVisible();

  // Step 4: change it from the page; the admission on the card changes.
  await page.getByRole('radio', { name: 'VIP' }).click();
  const patch = page.waitForResponse(
    (r) => /\/api\/v1\/passes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Update admission' }).click();
  expect((await patch).status()).toBe(200);
  await expect(page.getByText(/ETag/)).toBeVisible();
  await expect(preview.locator('.pc-value', { hasText: 'VIP' }).first()).toBeVisible();

  // Step 5: the events the sandbox captured, signed.
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.locator('.qs-cap', { hasText: 'webhook.test' })).toContainText('Verified');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /First pass in \d+:\d\d/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open your workbench' })).toBeVisible();

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

  // "Open your workbench" lands on the Workbench itself, not the developer front page, at every width.
  await page.getByRole('link', { name: 'Open your workbench' }).click();
  await page.waitForURL((u) => u.pathname === '/developers' && u.hash === '#workbench');
  for (const [width, height] of [
    [1440, 900],
    [834, 1112],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/developers#workbench');
    await expect(page.locator('#workbench .wb')).toBeVisible();
    await expect(page.locator('#workbench')).toBeInViewport();
    await expect(page.locator('#workbench')).toBeFocused();
    // Below the sticky bar, not under it.
    const top = (await page.locator('#workbench').boundingBox())?.y ?? 0;
    expect(top).toBeGreaterThanOrEqual(56);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The workbench: Reset deletes the test data, restarts the track and shows the new key once.
  await page.goto('/developers');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(
    page.getByText('Passes, events and logs in this sandbox are deleted.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reset sandbox' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Reset\. Deleted 1 pass/ }),
  ).toBeVisible();
  await expect(page.getByText(/PASSBOOK_KEY=pbp_test_/)).toBeVisible();
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
