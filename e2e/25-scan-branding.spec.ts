import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { makePng } from '../src/worker/modules/templates/package/fixtures.ts';
import { apiAs } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function pair(page: Page, code: string, sha: string) {
  await page.goto(`/scan#pair=${code}`);
  const logoResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/scan/branding/logo') && response.status() === 200,
  );
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.locator('.scan-capsule-logo, .scan-live-logo')).toBeVisible();
  const image = await logoResponse;
  expect(image.headers()['content-type']).toBe('image/png');
  expect(image.url()).toContain(`v=${sha}`);
}

test('paired scanner, operator and customer surfaces use authenticated org branding', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const contexts: BrowserContext[] = [];
  try {
    const { org } = readSeed();
    const x3 = makePng(480, 150);
    const x2 = makePng(320, 100);
    const updated = await api.send('PATCH', `/api/v1/orgs/${org.id}`, {
      branding: { accent: '#0f766e' },
    });
    expect(updated.branding.accent).toBe('#0f766e');
    const uploaded = await api.send('PUT', `/api/v1/orgs/${org.id}/branding/logo`, {
      x3: encode(x3),
      x2: encode(x2),
    });
    const sha = uploaded.branding.logo.sha as string;

    const session = await api.send('POST', '/api/v1/scanning-sessions', {
      orgId: org.id,
      name: 'Branded check-in',
      timeZone: 'UTC',
    });
    const devices = await Promise.all(
      (['phone', 'operator', 'customer'] as const).map((surface) =>
        api.send('POST', `/api/v1/scanning-sessions/${session.id}/devices`, {
          name: `Branded ${surface}`,
          surface,
        }),
      ),
    );
    const pairOn = async (
      device: { pairing?: { code?: string } | null },
      viewport: { width: number; height: number },
    ) => {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      contexts.push(context);
      const page = await context.newPage();
      await pair(page, device.pairing?.code ?? '', sha);
      const surface = page.locator('[data-testid="scan-live"], .scan-shell');
      await expect
        .poll(() =>
          surface.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--scan-org-accent'),
          ),
        )
        .toBe('#0f766e');
      await expect(page.locator('.scan-capsule-logo, .scan-live-logo')).toHaveAttribute(
        'alt',
        `${org.name} logo`,
      );
      return page;
    };

    const [phone, operator, customer] = await Promise.all([
      pairOn(devices[0], { width: 390, height: 844 }),
      pairOn(devices[1], { width: 1366, height: 900 }),
      pairOn(devices[2], { width: 820, height: 1180 }),
    ]);
    await expect(phone.getByTestId('scan-start')).toBeVisible();
    await operator.getByTestId('scan-start').click();
    await expect(operator.getByRole('complementary', { name: 'Operator view' })).toBeVisible();
    await expect(customer.getByTestId('scan-live')).toHaveAttribute('data-view', 'customer');
    await expect(customer.getByTestId('scan-live')).not.toContainText('Private pass holder');
    await expect(customer.locator('.scan-live-logo')).toHaveJSProperty('naturalWidth', 480);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api.dispose();
  }
});
