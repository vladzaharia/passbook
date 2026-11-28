import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';
import { VIEWS } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

const DIR = process.env.W7_SHOTS ?? process.env.SHOTS_DIR;

async function serious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** Every width in both themes: axe finds nothing serious, nothing scrolls sideways, and the shot is kept. */
async function check(page: Page, name: string) {
  await page.waitForTimeout(700);
  if (DIR) mkdirSync(DIR, { recursive: true });
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      expect(await serious(page), `${name} ${width} ${scheme}`).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} ${width} overflows`,
      ).toBe(true);
      if (DIR)
        await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

test('Send events: pick the tile, set up both sides, and land on the endpoint', async ({
  page,
}) => {
  test.setTimeout(160_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const org = encodeURIComponent(readSeed().org.id);
  const url = `https://hooks.example.com/hooks/${uid('out')}`;

  // The picker has the tile, in its own group, and Next goes to the endpoint step.
  await page.goto(`/admin/o/${org}/connections/new`);
  const tile = page.getByRole('radio', { name: /Send to your server/ });
  await expect(tile).toBeVisible();
  await check(page, 'outbound-picker');
  // The radio is drawn as the tile: its label takes the press.
  await page.getByText('Send to your server').click();
  await expect(tile).toBeChecked();
  await next(page);
  await page.waitForURL(/\/connections\/new\?source=outbound/);
  await expect(page.getByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'In PassBook' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'On your server' })).toBeVisible();

  await page.getByRole('textbox', { name: /URL/ }).fill(url);
  await page.getByRole('textbox', { name: /URL/ }).blur();
  await check(page, 'outbound-where');
  await next(page);
  await expect(page.getByRole('heading', { name: 'Choose events', level: 2 })).toBeVisible();
  await check(page, 'outbound-events');
  await next(page);
  await expect(page.getByRole('button', { name: 'Add endpoint', exact: true })).toBeVisible();
  await check(page, 'outbound-review');
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();

  // The secret is shown once; Next waits for the copy.
  await expect(page.getByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  await check(page, 'outbound-secret');
  // On a phone the bar hides its hint: a blocked Next says why in a toast.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Next', exact: true }).click({ force: true });
  await expect(page.getByText('Confirm you saved it.').first()).toBeVisible();
  if (DIR) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/outbound-blocked-next-390-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await next(page);

  await expect(page.getByRole('heading', { name: 'Check the signature', level: 2 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Node' })).toBeVisible();
  await check(page, 'outbound-verify');
  await next(page);

  // The receiver is a pinned host that refuses: the test reports why instead of failing silently.
  await expect(page.getByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible({ timeout: 20_000 });
  await check(page, 'outbound-test');
  // The pinned receiver cannot answer: stub the test's answer for the delivered state.
  await page.route('**/api/v1/webhook-endpoints/*/test', (route) =>
    route.fulfill({
      json: { ok: true, status: 200, durationMs: 140, errorCode: null, captureId: null },
    }),
  );
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByText('Delivered', { exact: true }).first()).toBeVisible();
  await check(page, 'outbound-test-delivered');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'hooks.example.com is set up' })).toBeVisible();
  await check(page, 'outbound-finish');
  await page.getByRole('button', { name: 'Open endpoint' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'hooks.example.com' })).toBeVisible();
  const endpointId = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
  // The stub proved nothing to PassBook: the endpoint is still untested, with the way back to setup.
  await expect(page.getByRole('link', { name: 'Finish setup' })).toBeVisible();
  await check(page, 'outbound-detail-overview');
  await page.getByRole('tab', { name: 'Signing' }).click();
  await expect(page.getByRole('heading', { name: 'Verify requests' })).toBeVisible();
  await check(page, 'outbound-detail-signing');

  // The secret was shown once: setup resumes at Verify from the endpoint alone.
  await page.goto(`/admin/o/${org}/connections/webhooks/${endpointId}/setup`);
  await expect(page.getByRole('heading', { name: 'Check the signature', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your server', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New secret' })).toBeVisible();
  await check(page, 'outbound-resume');

  const api = await apiAs('admin');
  await api.send('DELETE', `/api/v1/webhook-endpoints/${endpointId}`);
  await api.dispose();
});

test('the old Add endpoint URLs open the wizard on the outbound path', async ({ page }) => {
  const org = encodeURIComponent(readSeed().org.id);
  for (const path of [
    `/admin/o/${org}/connections/webhooks/new`,
    '/admin/connections/webhooks/new',
  ]) {
    await page.goto(path);
    await page.waitForURL(/\/connections\/new\?source=outbound/);
    await expect(page.getByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
  }
  // Add endpoint on the tab is a link to the same place.
  await page.goto(`/admin/o/${org}/connections?tab=webhooks`);
  await expect(page.getByRole('link', { name: 'Add endpoint' }).first()).toHaveAttribute(
    'href',
    /connections\/new\?source=outbound/,
  );
});

test('a refused URL says why on the endpoint step, and stays there', async ({ page }) => {
  const org = encodeURIComponent(readSeed().org.id);
  await page.goto(`/admin/o/${org}/connections/new?source=outbound`);
  await page.getByRole('textbox', { name: /URL/ }).fill('http://plain.example.com');
  await next(page);
  await expect(page.getByText('Use an https URL.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
});
