import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { makePng } from '../src/worker/modules/templates/package/fixtures.ts';
import { apiAs } from './helpers/api.ts';
import { pairScanner } from './helpers/pair.ts';
import { readSeed } from './helpers/seed.ts';

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function pair(page: Page, code: string, sha: string) {
  const logoResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/scan/branding/logo') && response.status() === 200,
  );
  await pairScanner(page, code);
  await expect(
    page.locator('.scan-capsule-logo, .scan-live-logo, .cstage-brand-logo'),
  ).toBeVisible();
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
      customer = false,
    ) => {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      contexts.push(context);
      const page = await context.newPage();
      await pair(page, device.pairing?.code ?? '', sha);
      const surface = page.locator('.cstage, .scan-shell');
      await expect
        .poll(() =>
          surface.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--scan-org-accent'),
          ),
        )
        .toBe('#0f766e');
      // The customer stage names the org in text beside the logo, so its logo alt is generic.
      await expect(
        page.locator('.scan-capsule-logo, .scan-live-logo, .cstage-brand-logo'),
      ).toHaveAttribute('alt', customer ? 'Organization logo' : `${org.name} logo`);
      return page;
    };

    const [phone, operator, customer] = await Promise.all([
      pairOn(devices[0], { width: 390, height: 844 }),
      pairOn(devices[1], { width: 1366, height: 900 }),
      pairOn(devices[2], { width: 820, height: 1180 }, true),
    ]);
    await expect(phone.getByTestId('scan-start')).toBeVisible();
    await operator.getByTestId('scan-start').click();
    await expect(operator.getByTestId('operator-workspace')).toBeVisible();
    await expect(customer.getByTestId('duo-customer-display')).toBeVisible();
    await expect(customer.getByTestId('duo-customer-display')).not.toContainText(
      'Private pass holder',
    );
    await expect(customer.locator('.cstage-brand-logo')).toHaveJSProperty('naturalWidth', 480);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api.dispose();
  }
});
