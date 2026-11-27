import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { freshAdminApi, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

const SHOTS = '.wrangler/agent-logs/wh-recover-shots';
const SIZES = [
  ['desktop', 1440, 900],
  ['tablet', 820, 1180],
  ['phone', 390, 844],
] as const;

async function serious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

test.describe('webhooks console, every size and theme', () => {
  let endpointId = '';
  test.beforeAll(async ({ browser }) => {
    const api = await freshAdminApi(browser);
    const made = await api.send('POST', '/api/v1/webhook-endpoints', {
      orgId: readSeed().org.id,
      url: `https://hooks.example.com/hooks/${uid('vis')}`,
      eventTypes: ['pass.issued', 'pass.scanned'],
      description: 'Orders',
    });
    endpointId = made.endpoint.id;
    await api.dispose();
  });
  test.afterAll(async ({ browser }) => {
    const api = await freshAdminApi(browser);
    await api.send('DELETE', `/api/v1/webhook-endpoints/${endpointId}`);
    await api.dispose();
  });

  for (const [size, width, height] of SIZES) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${size}, ${scheme}: list, wizard, detail`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        const org = encodeURIComponent(readSeed().org.id);
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        const pages: [string, string, () => Promise<void>][] = [
          [
            'list',
            `/admin/o/${org}/connections?tab=webhooks`,
            async () => {
              await expect(page.getByRole('tabpanel', { name: 'Webhook endpoints' })).toBeVisible();
            },
          ],
          [
            'wizard',
            `/admin/o/${org}/connections/webhooks/new`,
            async () => {
              await expect(
                page.getByRole('heading', { name: 'Where to send', level: 2 }),
              ).toBeVisible();
            },
          ],
          [
            'detail',
            `/admin/o/${org}/connections/webhooks/${endpointId}`,
            async () => {
              await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
            },
          ],
        ];
        for (const [name, path, ready] of pages) {
          await page.goto(path);
          await ready();
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png`, fullPage: true });
          expect(await serious(page), name).toEqual([]);
          // No sideways scroll at any size.
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            `${name} overflows`,
          ).toBe(true);
        }
      });
    }
  }
});
