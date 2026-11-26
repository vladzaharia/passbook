import { type BrowserContext, expect, test } from '@playwright/test';
import {
  apiAs,
  createPass,
  requireActiveTemplateRelease,
  seedTemplateId,
  uid,
} from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { pairScanner } from './helpers/pair.ts';
import { hardwareCode, refreshScannerSession } from './helpers/scan-input.ts';
import { readSeed } from './helpers/seed.ts';

test('shared sessions pair multiple devices, configure live, and keep lookup and customer display private', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const contexts: BrowserContext[] = [];
  try {
    const orgId = readSeed().org.id;
    const release = await requireActiveTemplateRelease(api, orgId, seedTemplateId(), 'live');
    const admin = await browser.newContext({
      storageState: stateFile('admin'),
      reducedMotion: 'reduce',
    });
    contexts.push(admin);
    const page = await admin.newPage();
    await page.goto(`/admin/scanning?orgId=${orgId}&tab=devices`);
    await page.getByRole('button', { name: 'New session', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    const name = uid('Shared membership');
    await dialog.getByRole('textbox', { name: 'Session name', exact: true }).fill(name);
    const nextTo = async (heading: string) => {
      for (let i = 0; i < 6; i++) {
        if (await dialog.getByRole('heading', { name: heading }).isVisible()) return;
        await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      }
    };
    await nextTo('Set check-in rules');
    await dialog.getByRole('combobox', { name: 'Check-in type', exact: true }).click();
    await page.getByRole('option', { name: 'Track in / out', exact: true }).click();
    await nextTo('Set device defaults');
    await dialog.getByRole('combobox', { name: 'Default reader', exact: true }).click();
    await page.getByRole('option', { name: 'Hardware / keyboard scanner', exact: true }).click();
    await nextTo('Check and create');
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click();
    await page.waitForURL(/\/admin\/o\/[^/]+\/scanning\/sessions\//);
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    const add = page.getByRole('dialog', { name: 'Add device', exact: true });
    await expect(add).toBeVisible();
    const deviceName = uid('Operator browser');
    await add.getByRole('textbox', { name: 'Device name', exact: true }).fill(deviceName);
    await add.getByRole('button', { name: /^Operator/ }).click();
    const creation = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/scanning-sessions/${sessionId}/devices`) &&
        r.request().method() === 'POST',
    );
    await add.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    const operator = await (await creation).json();
    await expect(page.getByRole('dialog', { name: `Pair ${deviceName}` })).toBeVisible();
    await page
      .getByRole('dialog', { name: `Pair ${deviceName}` })
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const display = await api.send('POST', `/api/v1/scanning-sessions/${sessionId}/devices`, {
      name: uid('Visitor display'),
      surface: 'customer',
    });
    const second = await api.send('POST', `/api/v1/scanning-sessions/${sessionId}/devices`, {
      name: uid('Exit phone'),
      surface: 'phone',
      overrides: { direction: 'out' },
    });
    const pair = async (code: string, width: number) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      contexts.push(context);
      const scanner = await context.newPage();
      await pairScanner(scanner, code);
      return scanner;
    };
    const desk = await pair(operator.pairing.code, 1360);
    const customer = await pair(display.pairing.code, 800);
    const phone = await pair(second.pairing.code, 390);
    await desk.getByTestId('scan-start').click();
    await phone.getByTestId('scan-start').click();
    // The operator holds results from the start; only the phone needs the switch.
    await phone.getByRole('button', { name: 'Menu', exact: true }).click();
    await phone.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
    await phone.keyboard.press('Escape');
    await expect(desk.getByTestId('operator-workspace')).toBeVisible();
    await expect(customer.getByTestId('duo-customer-display')).toHaveAttribute(
      'data-status',
      'ready',
    );
    await expect(phone.locator('.scan-shell')).toHaveAttribute('data-surface', 'phone');
    const memberId = uid('MEMBER').toUpperCase();
    const holderName = uid('Shared Session Member');
    const pass = await createPass(api, orgId, { holder: holderName, memberId });
    expect(pass).toMatchObject({
      orgId,
      templateId: seedTemplateId(),
      templateVersion: release.version,
      mode: 'live',
    });
    const field = desk.getByRole('combobox', { name: 'Name, email or code', exact: true });
    await field.fill(holderName);
    const previewAsset = desk.waitForResponse((r) =>
      r.url().includes(`/scan/passes/${pass.id}/assets/`),
    );
    await desk.getByRole('option', { name: new RegExp(holderName) }).click();
    expect((await previewAsset).status()).toBe(200);
    const ledger = async () =>
      (await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}`)).items;
    expect(await ledger()).toHaveLength(0);
    await desk.getByRole('button', { name: /^Close/ }).click();
    await field.fill('');
    await field.focus();
    await hardwareCode(desk, memberId);
    await expect(desk.getByTestId('scan-result')).toContainText('Checked in');
    await expect(customer.getByRole('heading', { name: 'Checked in', exact: true })).toBeVisible();
    await expect(customer.getByTestId('duo-customer-display')).not.toContainText(holderName);
    await phone.getByRole('button', { name: 'Enter code', exact: true }).click();
    await phone.getByRole('textbox', { name: 'Name, email or code', exact: true }).fill(memberId);
    await phone.getByRole('textbox', { name: 'Name, email or code', exact: true }).press('Enter');
    await expect(phone.getByTestId('scan-result')).toContainText('Checked out');
    // The customer screen shows the server's band (PS-30 #8): an exit reads Tapped out.
    await expect(customer.getByRole('heading', { name: 'Tapped out', exact: true })).toBeVisible();
    await expect.poll(async () => (await ledger()).length).toBe(2);
    await phone.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByTestId('session-device').filter({ hasText: deviceName })).toContainText(
      '1360 × 900',
    );
    await page.screenshot({ path: 'test-results/shared-session-admin.png', fullPage: true });
    const phoneCard = page.getByTestId('session-device').filter({ hasText: second.name });
    const configuration = page.getByRole('dialog', { name: `Configure ${second.name}` });
    // The paired devices write to their own rows in the background (reports, sign-ins), and a write that lands while the sheet is
    // open moves the device's revision: the save is then refused as stale (409). That refusal is the product working,
    // so the test opens the sheet again on the fresh revision and saves once more.
    for (let attempt = 1; ; attempt++) {
      await phoneCard.getByRole('button', { name: 'Configure device', exact: true }).click();
      await configuration.getByRole('button', { name: /^Operator/ }).click();
      await configuration.getByRole('combobox', { name: 'Reader', exact: true }).click();
      await page.getByRole('option', { name: 'Camera', exact: true }).click();
      // The sheet closes when the PATCH lands. Wait for that response, so a rejected save fails here with its status
      // instead of as a sheet that never closed, and a slow one under load gets the time it needs.
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' && /\/scanning-sessions\/[^/]+\/devices\//.test(r.url()),
      );
      await configuration.getByRole('button', { name: 'Save device', exact: true }).click();
      const status = (await saved).status();
      if (status === 409 && attempt < 3) {
        await page.keyboard.press('Escape');
        await expect(configuration).toBeHidden();
        continue;
      }
      expect(status).toBe(200);
      break;
    }
    await expect(configuration).toBeHidden({ timeout: 15_000 });
    // A refresh that raced the save returns the old configuration; each retry reads again.
    await expect(async () => {
      await refreshScannerSession(phone);
      await expect(phone.getByRole('complementary', { name: 'Operator view' })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
    await expect(phone.getByTestId('scan-start')).toHaveCount(0);
    await expect(phone.locator('video')).toHaveCount(0);
    await phone.screenshot({ path: 'test-results/shared-session-phone-operator.png' });
    await desk.getByRole('button', { name: /^Close/ }).click();
    const update = await api.send('PATCH', `/api/v1/scanning-sessions/${sessionId}`, {
      settings: { flow: 'choose' },
    });
    await expect
      .poll(async () => await desk.locator('[data-surface]').first().getAttribute('data-surface'))
      .toBe('operator');
    // Configuration refresh keeps this device started. A hardware scanner follows review mode.
    await expect(desk.getByTestId('scan-start')).toHaveCount(0);
    await refreshScannerSession(desk, (session) => session.scanner.settings.flow === 'choose');
    await field.focus();
    await hardwareCode(desk, memberId);
    await expect(desk.getByTestId('scan-result')).toContainText(holderName);
    expect(await ledger()).toHaveLength(2);
    await desk.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect.poll(async () => (await ledger()).length).toBe(3);
    await desk.screenshot({ path: 'test-results/shared-session-operator.png' });
    await api.send('PATCH', `/api/v1/scanning-sessions/${sessionId}`, {
      status: 'paused',
      revision: update.updatedAt,
    });
    await refreshScannerSession(phone);
    await expect(phone.getByRole('heading', { name: 'Session paused', exact: true })).toBeVisible();
    await refreshScannerSession(customer);
    await expect(
      customer.getByRole('heading', { name: 'Session paused', exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api.dispose();
  }
});

test('two devices pair from one rolling sheet', async ({ browser }) => {
  const api = await apiAs('admin');
  const contexts: BrowserContext[] = [];
  try {
    const orgId = readSeed().org.id;
    const name = uid('Rolling pair');
    const session = await api.send('POST', '/api/v1/scanning-sessions', {
      orgId,
      name,
      timeZone: 'UTC',
    });
    const admin = await browser.newContext({
      storageState: stateFile('admin'),
      reducedMotion: 'reduce',
    });
    contexts.push(admin);
    const page = await admin.newPage();
    await page.goto(`/admin/o/${orgId}/scanning/sessions/${session.id}`);
    await page.getByRole('button', { name: 'Pair devices', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Pair devices', exact: true });
    const codeOf = async () =>
      ((await sheet.locator('code').first().textContent()) ?? '').replace('-', '');
    const first = await codeOf();
    const join = async (code: string) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: 'reduce',
      });
      contexts.push(context);
      const scanner = await context.newPage();
      await pairScanner(scanner, code);
      await expect(scanner.getByTestId('scan-start')).toBeVisible();
    };
    await join(first);
    await expect(sheet.getByText('1 paired', { exact: true })).toBeVisible();
    await expect.poll(codeOf).not.toBe(first);
    await join(await codeOf());
    await expect(sheet.getByText('2 paired', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Done', exact: true }).click();
    const devices = async () =>
      (await api.get(`/api/v1/scanning-sessions/${session.id}`)).devices as {
        paired: boolean;
        revoked: boolean;
      }[];
    expect((await devices()).filter((d) => d.paired)).toHaveLength(2);
    // Closing revokes the unpaired row; the request settles after the dialog closes.
    await expect.poll(async () => (await devices()).filter((d) => !d.revoked).length).toBe(2);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api.dispose();
  }
});

test('signed-out people and regular users have pairing without administrator entry', async ({
  browser,
}) => {
  for (const storageState of [undefined, stateFile('user')]) {
    const context = await browser.newContext({
      storageState,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await page.goto('/scan?admin=1');
      const pairing = page.getByRole('button', { name: 'Use pairing code' });
      await expect(page.getByTestId('scan-pair').or(pairing)).toBeVisible();
      if (await pairing.isVisible()) await pairing.click();
      await expect(page.getByTestId('scan-pair')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Scan as Admin', exact: true })).toHaveCount(0);
      await page.screenshot({
        path: `test-results/pairing-${storageState ? 'user' : 'signed-out'}.png`,
      });
    } finally {
      await context.close();
    }
  }
});
