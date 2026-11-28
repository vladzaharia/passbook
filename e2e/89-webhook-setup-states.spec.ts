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

/** Pictures at three widths in both themes, then axe at the two ends. */
/** Every finite animation (entrances, transitions) is over; looping ones are left running. */
async function settled(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function check(page: Page, name: string) {
  await settled(page);
  await shots(page, name);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // The layout swaps at a breakpoint and the entrance runs again; axe reads colours after it.
      await settled(page);
      expect(await serious(page), `${name} ${width} ${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * A resize across the phone breakpoint remounts the panel and restarts its clock, so a timed state
 * is rebuilt (load, fast-forward) for every width and theme before its picture and axe run.
 */
async function timedShots(
  page: Page,
  name: string,
  url: string,
  minutes: number,
  until: () => Promise<void>,
) {
  const dir = process.env.D12_SHOTS ?? process.env.SHOTS_DIR;
  for (const [width, height] of [
    [1440, 900],
    [834, 1112],
    [390, 844],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(url);
      await expect(head(page, 'Listening · nothing yet')).toBeVisible();
      await page.clock.fastForward(minutes * 60_000 + 1000);
      await until();
      await settled(page);
      if (dir)
        await page.screenshot({ path: `${dir}/${name}-${width}-${scheme}.png`, fullPage: true });
      if (width !== 834) expect(await serious(page), `${name} ${width} ${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function made(secret: string) {
  const api = await apiAs('admin');
  const row = await api.send('POST', '/api/v1/connections', {
    orgId: readSeed().org.id,
    connectorType: 'webhook-push',
    name: `E2E Shopify ${uid('q')}`,
    config: { recipe: 'shopify-orders' },
    mode: 'webhook',
    webhookSecret: secret,
  });
  return { api, id: row.id as string };
}

const setup = (id: string) =>
  `/admin/o/${encodeURIComponent(readSeed().org.id)}/connections/${id}/setup`;
const head = (page: Page, name: string) => page.getByRole('heading', { name, level: 4 });

test('setup states: rejected', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const secret = `shpss_${uid('r')}${'0'.repeat(12)}`;
  const { api, id } = await made(secret);
  try {
    // Rejected: a delivery whose signature is wrong.
    await page.goto(setup(id));
    await expect(head(page, 'Listening · nothing yet')).toBeVisible();
    const body = '{"id":1}';
    const res = await page.request.post(`${BASE}/hooks/connections/${id}`, {
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': Buffer.from('wrong').toString('base64'),
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await expect(head(page, "Signature didn't match")).toBeVisible({ timeout: 20_000 });
    await check(page, 'webhook-rejected');
  } finally {
    await api.send('DELETE', `/api/v1/connections/${id}`);
    await api.dispose();
  }
});

test('setup states: ledger error, then skipped', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { api, id } = await made(`shpss_${uid('e')}${'0'.repeat(12)}`);
  try {
    await page.route('**/webhook-arrivals*', (route) =>
      route.fulfill({ status: 500, json: { code: 'internal' } }),
    );
    await page.goto(setup(id));
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
    await check(page, 'webhook-ledger-error');
    await page.unroute('**/webhook-arrivals*');

    await page.goto(setup(id));
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByText('Waiting for first event').first()).toBeVisible({
      timeout: 20_000,
    });
    await check(page, 'webhook-skipped');
  } finally {
    await api.send('DELETE', `/api/v1/connections/${id}`);
    await api.dispose();
  }
});

test('setup states: 3 minutes and paused, on a fake clock', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { api, id } = await made(`shpss_${uid('c')}${'0'.repeat(12)}`);
  try {
    await page.clock.install();
    const url = setup(id);
    await timedShots(page, 'webhook-slow', url, 3, () =>
      expect(head(page, 'Nothing arrived yet')).toBeVisible(),
    );
    await timedShots(page, 'webhook-paused', url, 15, async () => {
      await expect(head(page, 'Paused listening')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    });
  } finally {
    await api.send('DELETE', `/api/v1/connections/${id}`);
    await api.dispose();
  }
});
