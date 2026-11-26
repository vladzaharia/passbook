import { createHmac } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, BASE, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

async function serious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** Axe at the two ends of the widths, in both themes; the shots helper takes the pictures. */
async function check(page: Page, name: string) {
  await shots(page, name);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      expect(await serious(page), `${name} ${width} ${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

/** The wizard from Setup to Create, with a name. */
async function createThrough(page: Page, source: string, name: string) {
  const org = encodeURIComponent(readSeed().org.id);
  await page.goto(`/admin/o/${org}/connections/new?source=${source}`);
  await page.getByLabel(/^Name/).fill(name);
  return org;
}

const ORDER = (updatedAt: string) =>
  JSON.stringify({
    admin_graphql_api_id: 'gid://shopify/Order/820982911946154508',
    name: '#1001',
    order_number: 1001,
    email: 'maya@example.test',
    customer: { first_name: 'Maya', last_name: 'Chen' },
    current_total_price: '24.00',
    currency: 'USD',
    financial_status: 'paid',
    created_at: updatedAt,
    updated_at: updatedAt,
    line_items: [{ title: 'Day pass', quantity: 1 }],
  });

test('Shopify: create, paste the secret, a signed delivery is caught, finish', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `E2E Shopify ${uid('s')}`;
  const org = await createThrough(page, 'shopify-orders', name);
  // Source is chosen by the link, so the wizard starts at Setup with its rail in two groups.
  await expect(page.getByRole('group', { name: 'In PassBook' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'In Shopify' })).toBeVisible();
  await expect(page.getByLabel(/^Signing secret/)).toHaveCount(0);
  await next(page);
  await next(page);
  await next(page);
  await page.getByRole('button', { name: /^Create/ }).click();

  await page.waitForURL(/\/connections\/[^/]+\/setup$/);
  const id = new URL(page.url()).pathname.split('/').at(-2) as string;
  await expect(page.getByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
  const url = `${BASE}/hooks/connections/${id}`;
  await expect(page.getByRole('button', { name: 'Copy endpoint URL' }).first()).toBeVisible();
  await check(page, 'webhook-connect');

  await next(page);
  await expect(page.getByRole('heading', { name: 'Paste the secret', level: 2 })).toBeVisible();
  const secret = `shpss_${uid('k')}${'0'.repeat(12)}`;
  await page.getByLabel(/^Signing secret/).fill(secret);
  await check(page, 'webhook-secret');
  await page.getByRole('button', { name: 'Save secret' }).click();

  await expect(page.getByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Listening · nothing yet', level: 4 }),
  ).toBeVisible();
  await check(page, 'webhook-listening');

  // What Shopify sends: the raw body, its base64 HMAC and the topic.
  const body = ORDER(new Date().toISOString());
  const res = await page.request.post(url, {
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/create',
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'),
    },
    data: body,
  });
  expect(res.ok()).toBe(true);

  await expect(page.getByRole('heading', { name: 'Signed delivery seen', level: 4 })).toBeVisible({
    timeout: 20_000,
  });
  await check(page, 'webhook-caught');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shopify is connected' })).toBeVisible();
  await check(page, 'webhook-finish');
  await page.getByRole('button', { name: 'Open connection' }).click();
  await page.waitForURL((u) => u.pathname === `/admin/o/${org}/connections/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const api = await apiAs('admin');
  await api.send('DELETE', `/api/v1/connections/${id}`);
  await api.dispose();
});

test('Custom: the payload shape and its example, then the secret and the send snippets', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `E2E Custom ${uid('c')}`;
  await createThrough(page, 'custom', name);
  await page.getByLabel('Records', { exact: true }).fill('/items');
  await expect(page.getByText(/"items": \[/).first()).toBeVisible();
  await check(page, 'webhook-custom-setup');
  await next(page);
  await next(page);
  await next(page);
  await page.getByRole('button', { name: /^Create/ }).click();

  await page.waitForURL(/\/connections\/[^/]+\/setup$/);
  const id = new URL(page.url()).pathname.split('/').at(-2) as string;
  // PassBook made this secret: it comes first, and is shown once.
  await expect(page.getByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  await check(page, 'webhook-custom-secret');
  await page.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'curl' })).toBeVisible();
  await check(page, 'webhook-custom-connect');

  // Leaving setup: the connection page leads with the same live check and a way back.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Finish setup' })).toBeVisible();
  await expect(page.getByText('Listening for your system').first()).toBeVisible();
  await check(page, 'webhook-awaiting');

  const api = await apiAs('admin');
  await api.send('DELETE', `/api/v1/connections/${id}`);
  await api.dispose();
});
