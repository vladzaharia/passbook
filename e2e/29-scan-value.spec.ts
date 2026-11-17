import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { pairScanner } from './helpers/pair.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

const STAMP_CARD = 'baked:starter-stamp-card';
test.setTimeout(120_000);

test('a desk stamps a card by the amount it picks, then redeems the reward', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const template = await api.send(
      'POST',
      `/api/v1/templates/${encodeURIComponent(STAMP_CARD)}/clone`,
      { orgId, name: uid('Desk stamps') },
    );
    const release = await publishTemplateVersion(
      api,
      orgId,
      template.id,
      template.versions[0].version,
    );
    const cardNumber = uid('DESK').toUpperCase();
    const pass = await api.send(
      'POST',
      '/api/v1/passes',
      {
        orgId,
        templateId: template.id,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
        input: { holder: 'Desk Stamper', cardNumber, reward: 'Free coffee', stamps: 8 },
      },
      { 'Idempotency-Key': uid('idem'), 'x-passbook-mode': 'live' },
    );
    const scanner = await api.send('POST', '/api/v1/scanners', {
      orgId,
      name: uid('Desk'),
      kind: 'device',
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { flow: 'choose', reader: 'barcode', roleWithoutSignIn: 'desk' },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.assign(window, { PassBookNative: { onmessage: null, postMessage() {} } });
    });
    await pairScanner(page, scanner.pairing.code);
    await page.getByTestId('scan-start').click();
    const scan = (id: string) =>
      page.evaluate(
        ([value, scanId]) => {
          (
            window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
          ).PassBookNative.onmessage({
            data: JSON.stringify({
              version: 1,
              event: 'scan',
              source: 'barcode',
              id: scanId,
              value,
            }),
          });
        },
        [cardNumber, id],
      );
    const stampsOf = async () =>
      (await api.get<{ stamps: { count: number } }>(`/api/v1/passes/${pass.id}`)).stamps.count;

    await scan('desk-scan-1');
    await expect(page.getByRole('heading', { name: 'Choose an action' })).toBeVisible();
    await page.getByTestId('scan-action-stamp').click();
    await expect(page.getByTestId('scan-picker')).toBeVisible();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByTestId('scan-amount')).toHaveText('2');
    await expect(page.getByTestId('scan-picker-change')).toContainText('8 → 10');
    await page.getByTestId('scan-picker-commit').click();
    await expect(page.getByTestId('scan-result')).toContainText('Add stamp', { timeout: 10_000 });
    await expect(page.getByTestId('scan-result')).toHaveAttribute('data-kind', 'ok');
    expect(await stampsOf()).toBe(10);

    const redeemed = page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/scan/actions') && request.method() === 'POST',
    );
    await page.getByTestId('dock-primary').click();
    // The same code is ignored for 5 s after an accepted scan.
    await page.waitForTimeout(5_200);
    await scan('desk-scan-2');
    await expect(page.getByRole('heading', { name: 'Choose an action' })).toBeVisible();
    await page.getByTestId('scan-action-redeem').click();
    await expect(page.getByTestId('scan-picker')).toBeVisible();
    await page.getByTestId('scan-picker-commit').click();
    const request = await redeemed;
    expect(request.postDataJSON()).toMatchObject({ actionId: 'redeem', amount: 10 });
    await expect(page.getByTestId('scan-result')).toHaveAttribute('data-kind', 'ok', {
      timeout: 10_000,
    });
    expect(await stampsOf()).toBe(0);
  } finally {
    await context.close();
    await api.dispose();
  }
});
