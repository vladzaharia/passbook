import { expect, test } from '@playwright/test';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test('choose flow Check in button commits the selected action exactly once', async ({
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
      `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
      { orgId, name: uid('Choose flow') },
    );
    const release = await publishTemplateVersion(
      api,
      orgId,
      template.id,
      template.versions[0].version,
    );
    const memberId = uid('BUTTON').toUpperCase();
    const pass = await createPass(api, orgId, {
      templateId: template.id,
      release,
      memberId,
      holder: 'Action Button Guest',
    });
    const scanner = await api.send('POST', '/api/v1/scanners', {
      orgId,
      name: uid('Choose door'),
      kind: 'device',
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { flow: 'choose', reader: 'barcode' },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.assign(window, { PassBookNative: { onmessage: null, postMessage() {} } });
    });
    await page.goto(`/scan#pair=${encodeURIComponent(scanner.pairing.code)}`);
    await page.getByRole('heading', { name: 'Pair this device?' }).waitFor();
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('scan-start').click();
    await page.evaluate((code) => {
      (
        window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
      ).PassBookNative.onmessage({
        data: JSON.stringify({
          version: 1,
          event: 'scan',
          source: 'barcode',
          id: 'choose-scan',
          value: code,
        }),
      });
    }, memberId);
    await expect(page.getByRole('heading', { name: 'Choose an action' })).toBeVisible();
    const before = await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}`);
    expect(before.items).toHaveLength(0);
    const submitted = page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/scan/actions') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Checked in', { timeout: 5_000 });
    await expect(page.getByTestId('scan-result')).toContainText('Action Button Guest');
    const request = await submitted;
    expect(request.postDataJSON()).toMatchObject({
      actionId: 'check_in',
      input: { code: memberId, method: 'wedge' },
    });
    const after = await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}`);
    expect(after.items).toMatchObject([{ passId: pass.id, outcome: 'ok', actionId: 'check_in' }]);
  } finally {
    await context.close();
    await api.dispose();
  }
});
