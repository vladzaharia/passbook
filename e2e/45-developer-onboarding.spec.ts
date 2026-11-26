import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { e2eOrigin } from '../tools/lib/e2e-ports.ts';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { startOidcAs } from './helpers/auth.ts';
import { signInHolder } from './helpers/holder.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

const run = promisify(execFile);

/** A real curl process, as a developer would run it: the runner is the "terminal". */
async function curl(method: string, path: string, key: string, body?: unknown, idem?: string) {
  const args = ['-sS', '-X', method, '-w', '\n%{http_code}', `${e2eOrigin}/api/v1${path}`];
  args.push('-H', `Authorization: Bearer ${key}`, '-H', 'User-Agent: curl/8.7.1');
  if (idem) args.push('-H', `Idempotency-Key: ${idem}`);
  if (body !== undefined)
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  const { stdout } = await run('curl', args);
  const cut = stdout.lastIndexOf('\n');
  return {
    status: Number(stdout.slice(cut + 1)),
    json: JSON.parse(stdout.slice(0, cut) || 'null'),
  };
}

/** One fresh person (e2e-onboard) makes the one sandbox they can have, so this spec needs a fresh server. */
test('first pass in 5 minutes: sign in, curl from the runner, listener, PATCH, captures, done', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await stubTurnstile(page);

  // 1. Signed out the Workbench shows its sign-in state (T8 rebuilds the public first step).
  // The Workbench shell collapses its nav and the stage below 1440 px: the whole page is the desktop one.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Quickstart' })).toBeVisible();
  await shots(page, '01-signed-out');
  await startOidcAs(page, 'onboard', '/workbench/quickstart');
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');

  // 2. Sandbox: the key decodes once into the .env box.
  await page.getByRole('button', { name: 'Create sandbox' }).click();
  const env = page.locator('.qs-env-v');
  await expect(env).toContainText(/PASSBOOK_KEY=pbp_test_\S{20,}/);
  await shots(page, '02-sandbox-key');
  // Read the whole box the way a developer copies it, then mask it.
  const text = (await env.textContent()) ?? '';
  const [, key = '', templateId = ''] =
    text.match(/PASSBOOK_KEY=(pbp_test_\S+)\s+PASSBOOK_TEMPLATE_ID=(\S+)/) ?? [];
  expect(key).toMatch(/^pbp_test_/);
  expect(templateId).not.toBe('');
  await page.getByRole('button', { name: 'Next' }).click();

  // 3. curl from the runner: the page is listening for this key.
  await expect(page.getByText(/Listening for pbp_test_…[\w-]{4}/)).toBeVisible();
  await shots(page, '03-listening');
  const tpl = await curl('GET', `/templates/${templateId}`, key);
  expect(tpl.status).toBe(200);
  const input = { ...tpl.json.manifest.sample, attendee: 'Casey River', ticketId: 'QS-1042' };
  const { ticketId: _t, ...broken } = input;
  const bad = await curl('POST', '/passes', key, { templateId, input: broken }, uid('bad'));
  expect(bad.status).toBe(422);
  await expect(page.getByText('422 INVALID')).toBeVisible();
  // The field detail ("ticketId is required.") is not on the page today; T8's rebuild restores it.
  await expect(
    page.getByRole('alert').filter({ hasText: 'The pass input is invalid.' }),
  ).toBeVisible();
  await shots(page, '04-bad-call-422');
  const made = await curl('POST', '/passes', key, { templateId, input }, uid('good'));
  expect(made.status).toBe(201);
  await expect(page.getByText('201 CREATED')).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Your pass, live' });
  await expect(preview.getByText(/Rendered in/)).toBeAttached();
  await shots(page, '05-pass-from-curl', true);

  // 4. PATCH from the page, with If-Match; the runner then reads the change back.
  const id = made.json.id as string;
  await page.getByRole('radio', { name: 'VIP' }).click();
  const patch = page.waitForResponse(
    (r) => /\/api\/v1\/passes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Update admission' }).click();
  expect((await patch).status()).toBe(200);
  await expect(preview.locator('.pc-value', { hasText: 'VIP' }).first()).toBeAttached();
  const read = await curl('GET', `/passes/${id}`, key);
  expect(read.status).toBe(200);
  expect(JSON.stringify(read.json)).toContain('VIP');
  await shots(page, '06-changed', true);

  // 5. Captures: a signed test event lands.
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.locator('.qs-cap', { hasText: 'webhook.test' })).toContainText('Verified');
  // The events of the two calls leave through the queue within seconds, not on the minute sweep.
  await expect(page.locator('.qs-cap', { hasText: 'pass.issued' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('.qs-cap', { hasText: 'pass.updated' })).toBeVisible({
    timeout: 30_000,
  });
  await shots(page, '07-captures', true);

  // 6. Done.
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /First pass in \d+:\d\d/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Home' })).toBeVisible();
  await shots(page, '08-done');

  // Go to Home lands on the sandbox's Home in the Workbench; the header never shows Sign in beside it.
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await page.waitForURL(/\/workbench\/o\/[^/]+$/);
  await shots(page, '09-workbench');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeHidden();

  // Admin is pinned to Test: no Test switch, and the Overview points back to Developers.
  // The Overview is a lazy chunk with no placeholder: wait on its real activity read, not a longer timeout.
  const activity = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().includes('/api/v1/metrics/activity?'),
    { timeout: 60_000 },
  );
  await page.goto(`/admin/o/${await sandboxOrgId(page)}`);
  await activity;
  await expect(page.getByRole('link', { name: 'Open Developers' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toHaveCount(0);
  await shots(page, '10-admin-pinned');

  // Reset and Reopen move into the Workbench's Sandbox area (T8, a placeholder today); until it lands
  // Close and Reopen run on the server contract the area will call, and T8 restores the UI steps.
  // Closed, the workbench offers Reopen inside its window, and Reopen gives a replacement key.
  const closed = await page.evaluate(async () => {
    const who = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    const res = await fetch('/api/v1/developer/sandbox/close', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': who.csrfToken },
    });
    return res.status;
  });
  expect(closed).toBe(200);
  const reopened = await page.evaluate(async () => {
    const who = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    const res = await fetch('/api/v1/developer/sandbox/reopen', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': who.csrfToken },
    });
    return { status: res.status, text: await res.text() };
  });
  expect(reopened.status).toBe(200);
  expect(reopened.text).toMatch(/pbp_test_/);
});

test.describe('quickstart gates', () => {
  test.describe('signed in with Polaris ID but no developer group', () => {
    test.use({ storageState: 'e2e/.auth/user.json' });
    test('says so and offers the other account or the passes', async ({ page }) => {
      await page.goto('/workbench/quickstart');
      // Without the developer group the Workbench offers no sandbox. Its own "No developer access"
      // step returns with T8's Quickstart; today the shell's sign-in state is what shows.
      await expect(page.getByRole('main').getByRole('link', { name: /Polaris ID/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create sandbox' })).toHaveCount(0);
      await shots(page, '15-no-group');
    });
  });

  test.describe('email session', () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test('asks for Polaris ID and makes no sandbox', async ({ page }) => {
      const admin = await apiAs('admin');
      const email = `${uid('qsmail')}@example.test`;
      try {
        await createPass(admin, readSeed().org.id, { email });
      } finally {
        await admin.dispose();
      }
      await signInHolder(page, email);
      await page.goto('/workbench/quickstart');
      // An email session is not for the Workbench: it asks for Polaris ID and makes no sandbox.
      await expect(
        page.getByRole('heading', { level: 1, name: 'The Workbench needs Polaris ID.' }),
      ).toBeVisible();
      await expect(
        page.getByRole('main').getByRole('link', { name: /Polaris ID/ }),
      ).toHaveAttribute('href', /\/auth\/oidc\/start\?next=/);
      await expect(page.getByRole('button', { name: 'Create sandbox' })).toHaveCount(0);
      await shots(page, '16-email');
    });
  });
});
