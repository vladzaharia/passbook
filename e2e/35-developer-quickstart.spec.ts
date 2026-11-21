import { expect, test } from '@playwright/test';
import { apiAs } from './helpers/api.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The builder gets the one sandbox a person can have, so this spec needs a fresh server (the default). */
test('quickstart: from the page view to a 201 and the live TEST preview in six actions', async ({
  page,
  context,
}) => {
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

  let actions = 0;
  const act = async (go: () => Promise<unknown>) => {
    actions += 1;
    await go();
  };

  await page.goto('/developers/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your first pass' })).toBeVisible();
  // The signed-out page is the whole page: five steps and the empty pass.
  await expect(page.getByRole('listitem').filter({ hasText: 'Take it home' })).toBeVisible();

  await act(() => page.locator('main').getByRole('link', { name: 'Sign in' }).click());
  await act(() => page.getByRole('link', { name: 'Sign in with Polaris ID' }).click());
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');

  await act(() => page.getByRole('button', { name: 'Create sandbox' }).click());
  await expect(page.getByText(/^PASSBOOK_KEY=pbp_test_/)).toBeVisible();

  const passRequest = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/passes') && r.request().method() === 'POST',
  );
  await act(() => page.getByRole('button', { name: 'Run', exact: true }).click());
  expect((await passRequest).status()).toBe(201);
  await expect(page.getByText('201 CREATED')).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Your pass, live' });
  await expect(preview.getByText(/Rendered in/)).toBeVisible();
  // A sandbox pass is a preview on every channel, and says so.
  await expect(
    preview.getByRole('note').filter({ hasText: 'TEST PREVIEW · NOT INSTALLABLE' }),
  ).toBeVisible();
  await expect(preview.getByRole('link', { name: /\/preview\// })).toBeVisible();
  await expect(preview.getByAltText('QR code of the test preview link')).toBeVisible();
  await expect(preview.locator('.pc-value', { hasText: 'General' }).first()).toBeVisible();

  // Change it live: the admission on the card changes.
  const patch = page.waitForResponse(
    (r) => /\/api\/v1\/passes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await act(() => page.getByRole('button', { name: 'Update admission' }).click());
  expect((await patch).status()).toBe(200);
  await expect(preview.locator('.pc-value', { hasText: 'VIP' }).first()).toBeVisible();

  await act(() =>
    page
      .getByRole('listitem')
      .filter({ hasText: 'Take it home' })
      .getByRole('button', { name: 'Copy .env' })
      .click(),
  );
  await expect(page.getByRole('status').filter({ hasText: 'Your first pass, in' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^PASSBOOK_KEY=pbp_test_\S+\nPASSBOOK_TEMPLATE_ID=\S+\n$/,
  );
  expect(actions).toBeLessThanOrEqual(6);

  // The key lives in memory for the .env step: not in storage, not in the address.
  const kept = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]),
  );
  expect(kept).not.toMatch(/pbp_(test|live)_/);

  // The funnel carries a step and nothing else; sandbox create carries the page-view time.
  // A new person has no sandbox at the page view, so `view` is not sent: the time rides on the create call.
  expect(beacons.map((b) => b.step)).toEqual(['sandbox', 'run', 'live', 'change', 'home']);
  for (const b of beacons)
    expect(Object.keys(b).every((k) => k === 'step' || k === 'code')).toBe(true);
  expect(Object.keys(created ?? {}).sort()).toEqual(['turnstileToken', 'viewedAt']);

  // In Admin the sandbox is Test only: there is no Test switch, and the Overview points back here.
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: 'Open Developers' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Test mode' })).toHaveCount(0);
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
