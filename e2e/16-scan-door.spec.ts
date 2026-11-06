import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test('pair, Android barcode check-in, duplicate protection and undo', async ({ browser }) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const memberId = uid('SCAN').toUpperCase();
  const template = await api.send(
    'POST',
    `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
    { orgId, name: uid('Door template') },
  );
  const pass = await createPass(api, orgId, {
    memberId,
    holder: 'Scanner Guest',
    templateId: template.id,
  });
  const created = await api.send('POST', '/api/v1/scanners', {
    orgId,
    name: uid('Android door'),
    kind: 'device',
    accepts: { templateIds: [template.id] },
    timeZone: 'UTC',
    settings: { reader: 'barcode', lookup: true },
  });
  const lookupPass = await createPass(api, orgId, {
    memberId: uid('LOOKUP').toUpperCase(),
    holder: 'Lookup Guest',
    templateId: template.id,
  });
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const native = {
      sent: [] as Record<string, unknown>[],
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(message: string) {
        this.sent.push(JSON.parse(message));
      },
    };
    Object.assign(window, { PassBookNative: native });
  });
  try {
    await page.goto(`/scan#pair=${encodeURIComponent(created.pairing.code)}`);
    await expect(page.getByRole('heading', { name: 'Pair this device?' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('scan-start').click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
    await page.keyboard.press('Escape');
    const nativeRead = (id: string, value = memberId) =>
      page.evaluate(
        ({ id, value }) => {
          const bridge = (
            window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
          ).PassBookNative;
          bridge.onmessage({
            data: JSON.stringify({ version: 1, event: 'scan', source: 'barcode', id, value }),
          });
        },
        { id, value },
      );
    await nativeRead('first');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    await expect(page.getByTestId('scan-result')).toContainText('Scanner Guest');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { PassBookNative: { sent: Record<string, unknown>[] } }
            ).PassBookNative.sent
              .filter((m) => m.op === 'result' && m.id === 'first')
              .at(-1)?.outcome,
        ),
      )
      .toBe('accepted');
    await nativeRead('duplicate');
    const scans = await api.get(`/api/v1/scans?orgId=${orgId}`);
    expect(
      scans.items.filter(
        (s: { passId: string; outcome: string }) => s.passId === pass.id && s.outcome === 'ok',
      ),
    ).toHaveLength(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('scan-count')).toContainText('Today 0');
    await page.screenshot({ path: 'test-results/scanner-m1-android.png', fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name or full email' }).fill('Lookup');
    await page.getByRole('button', { name: /Lookup Guest/ }).click();
    await expect(page.getByRole('heading', { name: 'Lookup Guest' })).toBeFocused();
    // Picking a person resolves a card; the explicit primary is what checks them in.
    const before = await api.get(`/api/v1/scans?orgId=${orgId}&passId=${lookupPass.id}`);
    expect(before.items).toHaveLength(0);
    await expect(page.locator('.scan-pass-preview .pc-card')).toBeVisible();
    await page.screenshot({ path: 'test-results/scanner-lookup-confirm-phone.png' });
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Lookup Guest');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    await expect(page.getByTestId('scan-result')).toHaveAttribute('data-phase', 'up');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 390, 820, 1180]) {
        await page.setViewportSize({ width, height: width === 1180 ? 820 : 844 });
        const box = await page.getByTestId('scan-result').boundingBox();
        expect(box?.y).toBeGreaterThanOrEqual(width >= 1024 ? 108 : 117);
        expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(width >= 1024 ? 530 : 560);
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(accessibility.violations).toEqual([]);
        await page.screenshot({ path: `test-results/scanner-door-${width}-${colorScheme}.png` });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: 'View pass', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Pass', exact: true })).toBeVisible();
    await expect(page.locator('.pc-barcode')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Last scan:/ }).click();
    await expect(page.getByRole('heading', { name: 'Recent scans' })).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Lookup Guest');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'This shift', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Scans');
    await expect(page.getByRole('dialog')).toContainText('Done');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Last scan:/ }).click();
    await expect(page.getByRole('heading', { name: 'Recent scans' })).toBeVisible();
    await nativeRead('unknown', uid('UNKNOWN'));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('scan-verdict')).toHaveAttribute('data-kind', 'refused');
    await expect(page.getByRole('heading', { name: 'Not found', exact: true })).toBeVisible();
    await expect(page.getByTestId('scan-result')).toHaveAttribute('data-phase', 'up');
    await page.screenshot({ path: 'test-results/scanner-refused-phone.png' });
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('camera decodes a real QR frame through the wasm worker', async ({ browser }) => {
  const { default: bwipjs } = await import('bwip-js/node');
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const memberId = uid('CAMERA').toUpperCase();
  const template = await api.send(
    'POST',
    `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
    { orgId, name: uid('Camera ticket') },
  );
  await createPass(api, orgId, { memberId, holder: 'Camera Guest', templateId: template.id });
  const created = await api.send('POST', '/api/v1/scanners', {
    orgId,
    name: uid('Camera door'),
    kind: 'device',
    accepts: { templateIds: [template.id] },
    timeZone: 'UTC',
  });
  const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: memberId, scale: 6, padding: 6 });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    async ({ image }) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No test canvas');
        const qr = new Image();
        qr.src = image;
        await qr.decode();
        const draw = () => {
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(qr, 240, 120, 480, 480);
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(10);
      };
    },
    { image: `data:image/png;base64,${png.toString('base64')}` },
  );
  try {
    await page.goto(`/scan#pair=${encodeURIComponent(created.pairing.code)}`);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('scan-start').click();
    await expect(page.getByTestId('scan-result')).toContainText('Camera Guest', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    await expect(page.getByTestId('scan-result')).toHaveAttribute('data-phase', 'up');
    await page.screenshot({ path: 'test-results/scanner-m1-camera-phone.png' });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await api.dispose();
  }
});
