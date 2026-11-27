import { expect, test } from '@playwright/test';
import { apiAs, createPass, freshAdminApi, uid } from './helpers/api.ts';
import { stepUpAdmin } from './helpers/auth.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * The console against the real Worker. The URL must be https on 443 with a public host (the
 * SSRF rules), so the receiver is hooks.example.com, which the e2e server pins (WEBHOOK_TEST_DNS): a signed POST to it fails, which
 * is enough to see attempts, failures and replay in the console. Signed delivery and the
 * verification recipe are covered by the worker tests (sign.test, deliver.test, api-send.test).
 */
test('webhook endpoint: create, secret once, test event, delivery, pause, replay, delete', async ({
  page,
}) => {
  test.setTimeout(160_000);
  // Adding an endpoint needs a recent sign-in; a long CI shard's stored session is stale.
  await stepUpAdmin(page);
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  const path = `/hooks/${uid('e2e')}`;
  const url = `https://hooks.example.com${path}`;
  const api = await apiAs('admin');
  // An event from before the endpoint: the replay below picks it up.
  await createPass(api, seed.org.id, { email: `${uid('wh')}@example.test` });
  const issuedAt = Date.now();

  await page.goto(`/admin/o/${org}/connections?tab=webhooks`);
  await expect(page.getByRole('tab', { name: 'Webhook endpoints', selected: true })).toBeVisible();
  await expect(page.getByText('No webhooks')).toBeVisible();
  await page.getByRole('link', { name: 'Add endpoint' }).first().click();
  await page.waitForURL(/\/connections\/new\?source=outbound/);

  await page.getByRole('textbox', { name: /URL/ }).fill(url);
  await page.getByRole('textbox', { name: /URL/ }).blur();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();

  // The secret shows once, behind Show, and Next waits for "I saved the secret".
  await expect(page.getByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Show Signing secret' }).click();
  // The field shows the start of the secret (whsec_ and a token) and an ellipsis.
  const field = page.getByRole('status').filter({ hasText: /^whsec_/ });
  await expect(field).toBeVisible();
  const secret = ((await field.textContent()) ?? '').trim().split('…')[0] ?? '';
  expect(secret).toMatch(/^whsec_[\w-]{6}/);
  await page.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Test event: the lane reports delivered or the endpoint's answer, never a crash.
  await expect(page.getByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'hooks.example.com' })).toBeVisible();
  const endpointId = new URL(page.url()).pathname.split('/').pop() as string;

  // Gone for good: nothing on the detail page or its API shows the secret again.
  await expect(page.getByText(secret)).toHaveCount(0);
  const shown = JSON.stringify(await api.get(`/api/v1/webhook-endpoints/${endpointId}`));
  expect(shown).not.toContain(secret);

  // Issuing a pass queues a pass.issued delivery for this endpoint.
  await createPass(api, seed.org.id, { email: `${uid('wh')}@example.test` });
  // The list does not poll: wait for the delivery through the API, then reload.
  await expect
    .poll(
      async () =>
        (await api.get(`/api/v1/webhook-endpoints/${endpointId}/deliveries`)).items.some(
          (d: { type: string }) => d.type === 'pass.issued',
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  await page.reload();
  await page.getByRole('tab', { name: 'Deliveries' }).click();
  await page
    .getByRole('button', { name: /^Issued,/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Delivery' });
  await expect(sheet.getByRole('region', { name: 'Payload JSON' })).toContainText('pass.issued');
  await page.keyboard.press('Escape');

  // Pause and resume.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pause' }).click();
  await expect(page.getByText('Nothing is sent until you resume.')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Nothing is sent until you resume.')).toHaveCount(0);

  // The dialog's window ends at the last whole minute, so the early event must be older than that.
  await expect
    .poll(() => Math.floor((Date.now() - 1000) / 60_000) > Math.floor(issuedAt / 60_000), {
      timeout: 70_000,
    })
    .toBe(true);
  // Bulk replay: the pass issued before this endpoint existed is queued by "events from before".
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = page.getByRole('dialog', { name: 'Replay deliveries' });
  await replay.getByRole('checkbox', { name: /Also send events from before/ }).check();
  await expect(replay.getByRole('status')).toContainText(/\d+ deliver(y|ies) match/);
  await replay.getByRole('button', { name: /^Replay \d+$/ }).click();
  await expect(page.getByText(/Queued \d+ deliver/)).toBeVisible();

  // Delete, after the confirm.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('tab', { name: 'Webhook endpoints', selected: true })).toBeVisible();
  await expect(page.getByText('No webhooks')).toBeVisible();
  await api.dispose();
});

test('a reader-style masked URL never carries the path', async ({ browser }) => {
  const seed = readSeed();
  const api = await freshAdminApi(browser);
  const made = await api.send('POST', '/api/v1/webhook-endpoints', {
    orgId: seed.org.id,
    url: `https://hooks.example.com/hooks/${uid('mask')}`,
    eventTypes: ['pass.issued'],
  });
  const list = await api.get(`/api/v1/webhook-endpoints?orgId=${encodeURIComponent(seed.org.id)}`);
  const row = list.items.find((e: { id: string }) => e.id === made.endpoint.id);
  expect(row.urlMasked).toBe('hooks.example.com/…');
  await api.send('DELETE', `/api/v1/webhook-endpoints/${made.endpoint.id}`);
  await api.dispose();
});
