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
  const context = await browser.newContext({ reducedMotion: 'reduce' });
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
    const nativeRead = (id: string) =>
      page.evaluate(
        ({ id, value }) => {
          const bridge = (
            window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
          ).PassBookNative;
          bridge.onmessage({
            data: JSON.stringify({ version: 1, event: 'scan', source: 'barcode', id, value }),
          });
        },
        { id, value: memberId },
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
    await page.screenshot({ path: 'test-results/scanner-m1-camera-phone.png' });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await api.dispose();
  }
});
