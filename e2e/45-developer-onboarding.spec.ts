import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { e2eOrigin } from '../tools/lib/e2e-ports.ts';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { startOidcAs } from './helpers/auth.ts';
import { signInHolder } from './helpers/holder.ts';
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

  // 1. Signed out the page is the whole page, with the empty pass.
  await page.goto('/developers/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your first pass' })).toBeVisible();
  await shots(page, '01-signed-out');
  await startOidcAs(page, 'onboard', '/developers/quickstart');
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');

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
  await expect(page.getByRole('alert').filter({ hasText: 'ticketId is required.' })).toBeVisible();
  await shots(page, '04-bad-call-422');
  const made = await curl('POST', '/passes', key, { templateId, input }, uid('good'));
  expect(made.status).toBe(201);
  await expect(page.getByText('201 CREATED')).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Your pass, live' });
  await expect(preview.getByText(/Rendered in/)).toBeVisible();
  await shots(page, '05-pass-from-curl', true);

  // 4. PATCH from the page, with If-Match; the runner then reads the change back.
  const id = made.json.id as string;
  await page.getByRole('radio', { name: 'VIP' }).click();
  const patch = page.waitForResponse(
    (r) => /\/api\/v1\/passes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Update admission' }).click();
  expect((await patch).status()).toBe(200);
  await expect(preview.locator('.pc-value', { hasText: 'VIP' }).first()).toBeVisible();
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
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /First pass in \d+:\d\d/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open your workbench' })).toBeVisible();
  await shots(page, '08-done');

  // The workbench carries the same journey.
  await page.getByRole('link', { name: 'Open your workbench' }).click();
  await page.waitForURL((u) => u.pathname === '/developers');
  await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
  await shots(page, '09-workbench');
  // The header never shows Sign in beside the session chip while the account menu loads.
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeHidden();
  // Calls leaves out the page's own polling and keeps what was made: the 422, the create and the PATCH.
  const calls = page.getByRole('region', { name: 'Calls' });
  await expect(calls.getByText('422', { exact: true })).toBeVisible();
  await expect(calls.getByText('/api/v1/passes', { exact: true }).first()).toBeVisible();
  await expect(calls.getByRole('link', { name: /PATCH \/api\/v1\/passes\/:id/ })).toBeVisible();
  await expect(calls.getByText(/\/captures/)).toHaveCount(0);

  // Admin is pinned to Test: no Test switch, and the Overview points back to Developers.
  // The Overview is a lazy chunk with no placeholder: wait on its real activity read, not a longer timeout.
  const activity = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().includes('/api/v1/metrics/activity?'),
    { timeout: 60_000 },
  );
  await page.goto('/admin');
  await activity;
  await expect(page.getByRole('link', { name: 'Open Developers' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toHaveCount(0);
  await shots(page, '10-admin-pinned');

  // Reset confirms, deletes the test data and shows the new key once; the old key stops.
  await page.goto('/developers');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(
    page.getByText('Passes, events and logs in this sandbox are deleted.'),
  ).toBeVisible();
  await shots(page, '11-reset-confirm');
  await page.getByRole('button', { name: 'Reset sandbox' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Reset\. Deleted 1 pass/ }),
  ).toBeVisible();
  await expect(page.getByText(/pbp_test_/).first()).toBeVisible();
  // The workbench already shows the emptied sandbox: the old calls are gone before Done is pressed.
  await expect(
    page.getByRole('region', { name: 'Calls' }).getByText('422', { exact: true }),
  ).toHaveCount(0);
  await shots(page, '12-reset-done');
  expect((await curl('GET', '/passes', key)).status).toBe(401);

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
  await page.goto('/developers');
  await expect(page.getByTestId('wb-closed')).toContainText('Reopen within');
  await shots(page, '13-closed');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Reopened. Your key was replaced.')).toBeVisible();
  // The refresh that Reopen causes does not take the new key off the page.
  await expect(page.getByText(/PASSBOOK_KEY=pbp_test_/)).toBeVisible();
  await shots(page, '14-reopened');
});

test.describe('quickstart gates', () => {
  test.describe('signed in with Polaris ID but no developer group', () => {
    test.use({ storageState: 'e2e/.auth/user.json' });
    test('says so and offers the other account or the passes', async ({ page }) => {
      await page.goto('/developers/quickstart');
      const step = page.getByRole('listitem').filter({ hasText: 'No developer access' });
      await expect(step.getByRole('link', { name: /Polaris ID/ })).toBeVisible();
      await expect(step.getByRole('link', { name: 'My passes' })).toBeVisible();
      await expect(page.getByText(/user@example\.test/)).toBeVisible();
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
      await page.goto('/developers/quickstart');
      const step = page.getByRole('listitem').filter({ hasText: 'Use Polaris ID' });
      await expect(step.getByRole('link', { name: /Polaris ID/ })).toHaveAttribute(
        'href',
        /\/auth\/oidc\/start\?next=/,
      );
      await expect(page.getByRole('button', { name: 'Create sandbox' })).toHaveCount(0);
      await shots(page, '16-email');
    });
  });
});
