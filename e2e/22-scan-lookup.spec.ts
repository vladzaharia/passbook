import { expect, test } from '@playwright/test';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test('one field supports hidden IDs, independent QR data, people review and HID keyboard scans', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const template = await api.send(
      'POST',
      `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
      { orgId, name: uid('Hidden lookup ID') },
    );
    const version = await api.get(
      `/api/v1/templates/${template.id}/versions/${template.activeVersion}`,
    );
    const manifest = structuredClone(version.manifest);
    manifest.inputs.properties.lookupId = { type: 'string', 'x-label': 'Membership number' };
    manifest.sample.lookupId = '00001234';
    manifest.scan = {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      ...manifest.scan,
      lookup: { input: 'lookupId' },
    };
    const saved = await api.send('POST', `/api/v1/templates/${template.id}/versions`, {
      manifest,
      passJson: version.passJson,
      assets: version.assets.map((a: { name: string; sha1: string }) => ({
        name: a.name,
        sha1: a.sha1,
      })),
      activate: true,
    });
    expect(saved.report.ok).toBe(true);
    const names = [
      'Hidden ID Guest',
      'HID Focus Guest',
      'HID Global Guest',
      'Lookup Review Guest',
      'Code Review Guest',
      'QR Payload Guest',
    ];
    const passIds: string[] = [];
    const qrCodes: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const qrCode = uid('QR').toUpperCase();
      qrCodes.push(qrCode);
      const pass = await createPass(api, orgId, {
        templateId: template.id,
        memberId: qrCode,
        holder: names[i],
        email: i === 3 ? 'review@example.test' : undefined,
        input: { lookupId: `0000123${i}` },
      });
      passIds.push(pass.id);
    }
    const ledger = async (i: number) =>
      (await api.get(`/api/v1/scans?orgId=${orgId}&passId=${passIds[i]}`)).items;
    const setup = await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: uid('HID desk'),
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'none', lookup: true },
    });
    const page = await context.newPage();
    await page.goto(`/scan#pair=${encodeURIComponent(setup.pairing.code)}`);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('scan-start').click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
    await page.keyboard.press('Escape');
    const open = async () => {
      await page.getByRole('button', { name: 'Look up', exact: true }).click();
      return page.getByRole('textbox', { name: 'Name, email, code or ID' });
    };
    // A typed ID follows auto flow, even though the QR encodes another value.
    let field = await open();
    await field.fill('00001230');
    await field.press('Enter');
    await expect(page.getByTestId('scan-result')).toContainText('Hidden ID Guest');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    expect(await ledger(0)).toHaveLength(1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // Bluetooth/USB HID readers generate a burst of keys plus Enter, including in the field.
    field = await open();
    await field.pressSequentially('00001231', { delay: 10 });
    await field.press('Enter');
    await expect(page.getByTestId('scan-result')).toContainText('HID Focus Guest');
    expect(await ledger(1)).toMatchObject([{ outcome: 'ok', method: 'wedge' }]);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('body').click({ position: { x: 3, y: 120 } });
    await page.keyboard.type('00001232', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-result')).toContainText('HID Global Guest');
    expect(await ledger(2)).toMatchObject([{ outcome: 'ok', method: 'wedge' }]);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    field = await open();
    await field.fill(qrCodes[5] ?? '');
    await field.press('Enter');
    await expect(page.getByTestId('scan-result')).toContainText('QR Payload Guest');
    expect(await ledger(5)).toHaveLength(1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // Enter on an email only resolves the person; one explicit Check in records attendance.
    field = await open();
    await field.fill('review@example.test');
    await field.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Lookup Review Guest', exact: true }),
    ).toBeVisible();
    expect(await ledger(3)).toHaveLength(0);
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    expect(await ledger(3)).toHaveLength(1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await api.send('PATCH', `/api/v1/scanners/${setup.id}`, { settings: { flow: 'choose' } });
    await page.reload();
    await page.getByTestId('scan-start').click();
    field = await open();
    await field.fill('00001234');
    await field.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Choose an action', exact: true }),
    ).toBeVisible();
    expect(await ledger(4)).toHaveLength(0);
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Code Review Guest');
    expect(await ledger(4)).toHaveLength(1);
  } finally {
    await context.close();
    await api.dispose();
  }
});
