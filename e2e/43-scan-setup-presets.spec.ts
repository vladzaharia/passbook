import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { pairScanner } from './helpers/pair.ts';
import { readSeed } from './helpers/seed.ts';

/** The preset, and the device the test pairs: a phone that checks in (not a customer screen or an out phone). */
const PRESETS = [
  ['front_desk', -1],
  ['event_night', -1],
  ['venue', -1],
  ['club', 0],
  ['conference', 1],
  ['gates', 0],
  ['capacity', 0],
] as const;

for (const [preset, at] of PRESETS) {
  test(`${preset}: wizard, Done, pairing link, PIN, scan, replay`, async ({ browser }) => {
    const api = await apiAs('admin');
    const orgId = readSeed().org.id;
    const admin = await browser.newContext({
      storageState: stateFile('admin'),
      reducedMotion: 'reduce',
    });
    const device = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    try {
      const page = await admin.newPage();
      await page.goto(`/admin/o/${orgId}/scanning/setup?preset=${preset}`);
      const door = uid('Door');
      await page.getByRole('textbox', { name: /Door name/ }).fill(door);
      if (preset === 'capacity')
        await page.getByRole('spinbutton', { name: 'Max inside' }).fill('40');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      // Who gets in: any pass type keeps the run short.
      await page.getByRole('switch', { name: 'Any pass type' }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      // Hours from a preset would refuse the scan outside them.
      if (await page.getByRole('radio', { name: 'Always open' }).isVisible()) {
        await page.getByRole('radio', { name: 'Always open' }).click();
        await page.getByRole('button', { name: 'Next', exact: true }).click();
      }
      // Who scans: staff with a PIN.
      await page.getByRole('radio', { name: 'Staff sign in with a PIN' }).click();
      if ((await page.getByRole('textbox', { name: 'Name', exact: true }).count()) === 0)
        await page.getByRole('button', { name: 'Add person', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Maya Chen');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Checks' })).toBeVisible();
      const applied = page.waitForResponse(
        (r) =>
          r.url().includes('/scanning-sessions/setup') &&
          !r.url().includes('dryRun') &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Set up', exact: true }).click();
      const response = await applied;
      expect(response.status()).toBe(200);
      const made = await response.json();
      const request = response.request();
      const key = request.headers()['idempotency-key'];
      expect(key).toBeTruthy();
      await expect(page.getByRole('heading', { name: `${door} is ready` })).toBeVisible();
      await expect(page.getByRole('region', { name: 'PINs' })).toContainText('Maya Chen');

      const pin = made.staff[0].pin as string;
      expect(pin).toMatch(/^\d{6}$/);
      const devices = made.sessions[0].devices as { pairing: { code: string } | null }[];
      const code = devices.at(at)?.pairing?.code;
      expect(code).toBeTruthy();

      const scanner = await device.newPage();
      await pairScanner(scanner, code as string);
      for (const digit of pin)
        await scanner.getByRole('button', { name: digit, exact: true }).click();
      await scanner.getByTestId('scan-start').click();

      const memberId = uid('MEMBER').toUpperCase();
      await createPass(api, orgId, { holder: uid('Holder'), memberId });
      await scanner.getByRole('button', { name: 'Enter code', exact: true }).click();
      const field = scanner.getByRole('textbox', { name: 'Name, email or code', exact: true });
      await field.fill(memberId);
      await field.press('Enter');
      await expect(scanner.getByTestId('scan-result')).toContainText('Checked in');

      // The same key and body replay: the same ids, no PINs.
      const replay = await api.send(
        'POST',
        '/api/v1/scanning-sessions/setup',
        request.postDataJSON(),
        {
          'Idempotency-Key': key as string,
        },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.sessions[0].id).toBe(made.sessions[0].id);
      expect(replay.staff.every((s: { pin?: string }) => !s.pin)).toBe(true);
    } finally {
      await admin.close();
      await device.close();
      await api.dispose();
    }
  });
}

test('club keeps its own defaults: anyone as Door, no forced PIN', async ({ browser }) => {
  const orgId = readSeed().org.id;
  const admin = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  try {
    const page = await admin.newPage();
    await page.goto(`/admin/o/${orgId}/scanning/setup?preset=club`);
    await page.getByRole('textbox', { name: /Door name/ }).fill(uid('Club'));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('switch', { name: 'Any pass type' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Checks' })).toBeVisible();
    await expect(page.getByText('Anyone, as Door')).toBeVisible();
    await expect(page.getByTestId('settings-line')).toHaveText('Check-in: in and out');
    const applied = page.waitForResponse(
      (r) =>
        r.url().includes('/scanning-sessions/setup') &&
        !r.url().includes('dryRun') &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    const made = await (await applied).json();
    expect(made.staff).toEqual([]);
    expect(made.sessions[0].devices).toHaveLength(2);
  } finally {
    await admin.close();
  }
});
