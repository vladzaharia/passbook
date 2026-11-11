import { type Browser, expect, type Page, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

async function paired(browser: Browser, code: string, reader = false) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  if (reader)
    await page.addInitScript(() => {
      Object.assign(window, { PassBookNative: { onmessage: null, postMessage() {} } });
    });
  await page.goto(`/scan#pair=${encodeURIComponent(code)}`);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  return { context, page };
}
const nativeRead = (page: Page, value: string) =>
  page.evaluate((code) => {
    (
      window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
    ).PassBookNative.onmessage({
      data: JSON.stringify({
        version: 1,
        event: 'scan',
        source: 'barcode',
        id: crypto.randomUUID(),
        value: code,
      }),
    });
  }, value);

const photoFixture = (page: Page, square = false) =>
  page.evaluate((square) => {
    const canvas = document.createElement('canvas');
    canvas.width = square ? 270 : 540;
    canvas.height = square ? 270 : 360;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas unavailable');
    c.fillStyle = '#eadac9';
    c.fillRect(0, 0, 540, 360);
    c.fillStyle = '#282c39';
    c.beginPath();
    c.arc(270, 110, 60, 0, Math.PI * 2);
    c.fill();
    c.fillRect(160, 200, 220, 160);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, square);

test('admin uploads a member photo, opts it into Wallet and configures in/out rules', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const context = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  try {
    const orgId = readSeed().org.id;
    const pass = await createPass(api, orgId, { holder: 'Photo Member' });
    const page = await context.newPage();
    await page.goto(`/admin/passes/${pass.id}?orgId=${encodeURIComponent(orgId)}`);
    await page.getByRole('tab', { name: 'Holder', exact: true }).click();
    const encoded = await photoFixture(page);
    await page.getByLabel('Member photo', { exact: true }).setInputFiles({
      name: 'member.png',
      mimeType: 'image/png',
      buffer: Buffer.from(encoded, 'base64'),
    });
    const image = page.getByRole('img', { name: 'Photo Member', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(270);
    expect((await api.get(`/api/v1/passes/${pass.id}/member-photo`)).includeInPass).toBe(false);
    await page.getByLabel('Include photo in Wallet pass').check();
    await expect
      .poll(async () => (await api.get(`/api/v1/passes/${pass.id}/member-photo`)).includeInPass)
      .toBe(true);
    const latest = await api.get(`/api/v1/passes/${pass.id}`);
    const download = await api.ctx.get(latest.downloadUrl);
    expect(download.ok()).toBe(true);
    expect(unzipSync(new Uint8Array(await download.body()))['thumbnail@3x.png']).toBeDefined();
    await page.getByRole('combobox', { name: 'Check-in type', exact: true }).click();
    await page.getByRole('option', { name: 'Track in / out', exact: true }).click();
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();
    await expect
      .poll(async () => (await api.get(`/api/v1/passes/${pass.id}/check-in`)).rules.mode)
      .toBe('in_out');
    await page.screenshot({ path: 'test-results/member-photo-rules.png', fullPage: true });
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('paired customer and legacy desk views follow real check-ins, exits and revocation', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const adminContext = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  const contexts = [adminContext];
  try {
    const orgId = readSeed().org.id;
    const template = await api.send(
      'POST',
      `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
      { orgId, name: uid('Membership view') },
    );
    const release = await publishTemplateVersion(
      api,
      orgId,
      template.id,
      template.versions[0].version,
    );
    const memberId = uid('MEMBER').toUpperCase();
    const holder = 'Multi View Member';
    const pass = await createPass(api, orgId, {
      templateId: template.id,
      memberId,
      holder,
      release,
    });
    await api.send('PUT', `/api/v1/passes/${pass.id}/check-in`, { rules: { mode: 'in_out' } });
    const sourceName = uid('Entry desk');
    const source = await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: sourceName,
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'barcode', direction: 'in' },
    });
    const exitName = uid('Exit desk');
    const exit = await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: exitName,
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'barcode', direction: 'out' },
    });
    const admin = await adminContext.newPage();
    await api.send('PUT', `/api/v1/passes/${pass.id}/member-photo`, {
      png: await photoFixture(admin, true),
    });
    const customerName = uid('Customer view');
    const customerSetup = await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: customerName,
      deviceRole: 'customer',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id, exit.id], allOrg: false },
    });
    const monitor = await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: uid('Desk view'),
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id, exit.id] },
    });
    const customer = await paired(browser, customerSetup.pairing.code);
    const desk = await paired(browser, monitor.pairing.code);
    const scanner = await paired(browser, source.pairing.code, true);
    const exitScanner = await paired(browser, exit.pairing.code, true);
    contexts.push(customer.context, desk.context, scanner.context, exitScanner.context);
    await expect(customer.page.getByTestId('scan-live')).toHaveAttribute('data-view', 'customer');
    await expect(desk.page.getByTestId('scan-live')).toHaveAttribute('data-view', 'monitor');
    await expect(desk.page.getByTestId('scan-start')).toHaveCount(0);
    await expect(desk.page.getByRole('button', { name: 'Look up', exact: true })).toHaveCount(0);
    await expect(desk.page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
    await expect(desk.page.getByRole('status')).toHaveText('Live');
    await scanner.page.getByTestId('scan-start').click();
    await exitScanner.page.getByTestId('scan-start').click();
    await scanner.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await scanner.page.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
    await scanner.page.keyboard.press('Escape');
    await nativeRead(scanner.page, memberId);
    await expect(scanner.page.getByTestId('scan-result')).toContainText('Checked in');
    await expect(
      customer.page.getByRole('heading', { name: 'Checked in', exact: true }),
    ).toBeVisible();
    await expect(customer.page.getByTestId('scan-live')).not.toContainText(holder);
    await expect(desk.page.getByTestId('scan-live')).toContainText(holder);
    await expect(desk.page.getByRole('img', { name: holder, exact: true })).toBeVisible();
    await expect
      .poll(() =>
        desk.page
          .getByRole('img', { name: holder, exact: true })
          .evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBe(270);
    await expect(customer.page.getByTestId('scan-live').locator('img')).toHaveCount(0);
    await expect(scanner.page.getByTestId('scan-result').locator('img')).toBeVisible();
    await nativeRead(exitScanner.page, memberId);
    await expect(exitScanner.page.getByTestId('scan-result')).toContainText('Checked out');
    await expect(
      customer.page.getByRole('heading', { name: 'Checked out', exact: true }),
    ).toBeVisible();
    const scans = await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}`);
    expect(scans.items.filter((s: { outcome: string }) => s.outcome === 'ok')).toHaveLength(2);
    await desk.page.screenshot({ path: 'test-results/scan-desk-view.png', fullPage: true });
    await api.send('POST', `/api/v1/scanners/${monitor.id}/revoke`);
    await expect(desk.page.getByTestId('scan-live')).toHaveCount(0, { timeout: 5000 });
    await expect(desk.page.locator('body')).not.toContainText(holder);
  } finally {
    for (const context of contexts) await context.close();
    await api.dispose();
  }
});

test('Scan as Admin is optional and reuses this browser’s device in a shared session', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const context = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  try {
    const org = readSeed().org;
    const parent = await api.send('POST', '/api/v1/scanning-sessions', {
      orgId: org.id,
      name: uid('Admin shared session'),
      timeZone: 'UTC',
      settings: { lookup: true },
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/scan?orgId=${org.id}&sessionId=${parent.id}`);
    await expect(page.getByTestId('scan-pair')).toBeVisible();
    await page.getByRole('button', { name: 'Scan as Admin', exact: true }).click();
    await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
    await page.getByRole('option', { name: org.name, exact: true }).click();
    await page.getByRole('button', { name: 'Join session', exact: true }).click();
    await page.waitForURL(/setupId=/);
    await expect(page.getByTestId('scan-start')).toBeVisible();
    const first = new URL(page.url()).searchParams.get('setupId');
    await page.goto(`/scan?admin=1&orgId=${org.id}&sessionId=${parent.id}`);
    await page.getByRole('button', { name: 'Join session', exact: true }).click();
    await page.waitForURL(/setupId=/);
    expect(new URL(page.url()).searchParams.get('setupId')).toBe(first);
    const setup = await api.get(`/api/v1/scan-setups/${first}`);
    expect(setup.adminSession).toBe(true);
    const member = await createPass(api, org.id, { holder: 'Admin Action Guest' });
    await page.getByTestId('scan-start').click();
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name, email, code or ID' }).fill('Admin Action');
    const asset = page.waitForResponse((r) =>
      r.url().includes(`/scan/passes/${member.id}/assets/`),
    );
    await page.getByRole('button', { name: /Admin Action Guest/ }).click();
    const loaded = await asset;
    expect(loaded.status()).toBe(200);
    expect(new URL(loaded.url()).searchParams.get('setupId')).toBe(first);
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    const scans = await api.get(`/api/v1/scans?orgId=${org.id}&passId=${member.id}`);
    expect(scans.items).toMatchObject([{ scannerId: first, outcome: 'ok' }]);
    await page.goto(
      `/admin/scanning/sessions/${parent.id}?orgId=${encodeURIComponent(org.id)}&deviceId=${first}`,
    );
    const configuration = page.getByRole('dialog', { name: `Configure ${setup.name}` });
    await expect(configuration).toContainText('Administrator sign-in');
    await expect(configuration.getByRole('button', { name: /^Pair/ })).toHaveCount(0);
    await configuration.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: parent.name, exact: true, level: 1 }),
    ).toBeVisible();
  } finally {
    await context.close();
    await api.dispose();
  }
});
