import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, GENERIC, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { readSeed } from './helpers/seed.ts';

async function hardwareCode(page: Page, value: string) {
  // Real HID readers send Shift for uppercase keys; Playwright typing alone omits it.
  for (const char of value) await page.keyboard.press(/[A-Z]/.test(char) ? `Shift+${char}` : char);
  await page.keyboard.press('Enter');
}

test('shared sessions pair multiple devices, configure live, and keep lookup and customer display private', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const contexts: BrowserContext[] = [];
  try {
    const orgId = readSeed().org.id;
    const release = await requireActiveTemplateRelease(api, orgId, GENERIC, 'live');
    const admin = await browser.newContext({
      storageState: stateFile('admin'),
      reducedMotion: 'reduce',
    });
    contexts.push(admin);
    const page = await admin.newPage();
    await page.goto(`/admin/scanning?orgId=${orgId}&tab=scanners`);
    await page.getByRole('button', { name: 'New scanning session', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New scanning session', exact: true });
    const name = uid('Shared membership');
    await dialog.getByRole('textbox', { name: 'Session name', exact: true }).fill(name);
    await dialog.getByRole('tab', { name: 'Admission', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Check-in type', exact: true }).click();
    await page.getByRole('option', { name: 'Track in / out', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Device defaults', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Default reader', exact: true }).click();
    await page.getByRole('option', { name: 'Hardware / keyboard scanner', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click();
    await page.waitForURL(/\/admin\/scanning\/sessions\//);
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
      await scanner.goto(`/scan#pair=${code}`);
      await scanner.getByRole('button', { name: 'Pair', exact: true }).click();
      return scanner;
    };
    const desk = await pair(operator.pairing.code, 1360);
    const customer = await pair(display.pairing.code, 800);
    const phone = await pair(second.pairing.code, 390);
    await desk.getByTestId('scan-start').click();
    await phone.getByTestId('scan-start').click();
    for (const scanner of [desk, phone]) {
      await scanner.getByRole('button', { name: 'Menu', exact: true }).click();
      await scanner.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
      await scanner.keyboard.press('Escape');
    }
    await expect(desk.getByRole('complementary', { name: 'Operator view' })).toBeVisible();
    await expect(customer.getByTestId('scan-live')).toHaveAttribute('data-view', 'customer');
    await expect(phone.locator('.scan-shell')).toHaveAttribute('data-surface', 'phone');
    const memberId = uid('MEMBER').toUpperCase();
    const pass = await createPass(api, orgId, { holder: 'Shared Session Member', memberId });
    expect(pass).toMatchObject({
      orgId,
      templateId: GENERIC,
      templateVersion: release.version,
      mode: 'live',
    });
    const field = desk.getByRole('textbox', { name: 'Name, email, code or ID', exact: true });
    await field.fill('Shared Session Member');
    const previewAsset = desk.waitForResponse((r) =>
      r.url().includes(`/scan/passes/${pass.id}/assets/`),
    );
    await desk.getByRole('button', { name: /Shared Session Member/ }).click();
    expect((await previewAsset).status()).toBe(200);
    const ledger = async () =>
      (await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}`)).items;
    expect(await ledger()).toHaveLength(0);
    await desk.getByRole('button', { name: 'Back', exact: true }).click();
    await field.fill('');
    await field.focus();
    await hardwareCode(desk, memberId);
    await expect(desk.getByTestId('scan-result')).toContainText('Checked in');
    await expect(customer.getByRole('heading', { name: 'Checked in', exact: true })).toBeVisible();
    await expect(customer.getByTestId('scan-live')).not.toContainText('Shared Session Member');
    await phone.getByRole('button', { name: 'Look up', exact: true }).click();
    await phone
      .getByRole('textbox', { name: 'Name, email, code or ID', exact: true })
      .fill(memberId);
    await phone
      .getByRole('textbox', { name: 'Name, email, code or ID', exact: true })
      .press('Enter');
    await expect(phone.getByTestId('scan-result')).toContainText('Checked out');
    await expect(customer.getByRole('heading', { name: 'Checked out', exact: true })).toBeVisible();
    await expect.poll(async () => (await ledger()).length).toBe(2);
    await phone.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByTestId('session-device').filter({ hasText: deviceName })).toContainText(
      '1360 × 900',
    );
    await page.screenshot({ path: 'test-results/shared-session-admin.png', fullPage: true });
    const phoneCard = page.getByTestId('session-device').filter({ hasText: second.name });
    await phoneCard.getByRole('button', { name: 'Configure device', exact: true }).click();
    const configuration = page.getByRole('dialog', { name: `Configure ${second.name}` });
    await configuration.getByRole('button', { name: /^Operator/ }).click();
    await configuration.getByRole('combobox', { name: 'Reader', exact: true }).click();
    await page.getByRole('option', { name: 'Camera', exact: true }).click();
    await configuration.getByRole('button', { name: 'Save device', exact: true }).click();
    await expect(phone.getByRole('complementary', { name: 'Operator view' })).toBeVisible({
      timeout: 20000,
    });
    await expect(phone.getByTestId('scan-start')).toHaveCount(0);
    await expect(phone.locator('video')).toHaveCount(0);
    await phone.screenshot({ path: 'test-results/shared-session-phone-operator.png' });
    await desk.getByRole('button', { name: 'Done', exact: true }).click();
    const update = await api.send('PATCH', `/api/v1/scanning-sessions/${sessionId}`, {
      settings: { flow: 'choose' },
    });
    await expect
      .poll(async () =>
        desk.evaluate(
          async () => (await (await fetch('/api/v1/scan/session')).json()).scanner.settings.flow,
        ),
      )
      .toBe('choose');
    await expect
      .poll(async () => await desk.locator('.scan-shell').getAttribute('data-surface'))
      .toBe('operator');
    // Configuration refresh keeps this device started. A hardware scanner follows review mode.
    await expect(desk.getByTestId('scan-start')).toHaveCount(0);
    const sessionRefresh = desk.waitForResponse(
      (r) => r.url().includes('/api/v1/scan/session') && r.status() === 200,
    );
    await desk.bringToFront();
    await sessionRefresh;
    await field.focus();
    await hardwareCode(desk, memberId);
    await expect(desk.getByTestId('scan-result')).toContainText('Shared Session Member');
    expect(await ledger()).toHaveLength(2);
    await desk.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect.poll(async () => (await ledger()).length).toBe(3);
    await desk.screenshot({ path: 'test-results/shared-session-operator.png' });
    await api.send('PATCH', `/api/v1/scanning-sessions/${sessionId}`, {
      status: 'paused',
      revision: update.updatedAt,
    });
    await expect(phone.getByRole('heading', { name: 'Session paused', exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(
      customer.getByRole('heading', { name: 'Session paused', exact: true }),
    ).toBeVisible({ timeout: 20000 });
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
