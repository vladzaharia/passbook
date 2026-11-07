import { expect, test } from '@playwright/test';
import { apiAs } from './helpers/api.ts';
import {
  cameraFixture,
  cameraFormats,
  installCamera,
  pairCamera,
  showBarcode,
} from './helpers/camera.ts';
import { readSeed } from './helpers/seed.ts';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await info.attach('camera-diagnostics', {
      body: JSON.stringify(
        await page.evaluate(() => (window as unknown as { cameraTest: object }).cameraTest),
      ),
      contentType: 'application/json',
    });
  }
});

test('all eight camera barcode formats check in continuously across phone, tablet and desktop', async ({
  page,
}, testInfo) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  try {
    const { scanner, items } = await cameraFixture(api, orgId);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installCamera(
      page,
      items.map((i) => i.image),
      { enumerateFails: true, constraintFails: true },
    );
    await page.route('**/*.wasm', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await pairCamera(page, scanner.pairing.code);
    await expect(page.getByText('Scan anywhere in view', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const measures = [];
    for (const [i, item] of items.entries()) {
      const viewport =
        i % 3 === 0
          ? { width: 390, height: 844 }
          : i % 3 === 1
            ? { width: 1180, height: 820 }
            : { width: 1440, height: 900 };
      await page.setViewportSize(viewport);
      const start = Date.now();
      await showBarcode(page, i, i % 2 ? 90 : 0, i % 3 === 0);
      await expect(page.getByTestId('scan-result')).toContainText(`Camera ${item.format}`, {
        timeout: 15_000,
      });
      await expect(page.getByTestId('scan-result')).toContainText('Checked in');
      measures.push({ format: item.format, milliseconds: Date.now() - start, viewport });
      await showBarcode(page, -1);
      await expect(page.getByTestId('scan-result')).not.toBeVisible({ timeout: 8_000 });
    }
    const scans = await api.get(`/api/v1/scans?orgId=${orgId}&scannerId=${scanner.id}`);
    for (const item of items)
      expect(
        scans.items.filter(
          (s: { passId: string; outcome: string; method: string }) =>
            s.passId === item.passId && s.outcome === 'ok' && s.method === 'camera',
        ),
      ).toHaveLength(1);
    expect(errors).toEqual([]);
    await testInfo.attach('camera-check-in-timings', {
      body: JSON.stringify(measures, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: `test-results/${testInfo.project.name}-camera.png` });
  } finally {
    await api.dispose();
  }
});

test('decodes barcodes at all four corners and edges without moving them into the guide', async ({
  page,
}, info) => {
  const api = await apiAs('admin');
  try {
    const { scanner, items } = await cameraFixture(api, readSeed().org.id);
    await installCamera(
      page,
      items.map((i) => i.image),
    );
    await pairCamera(page, scanner.pairing.code);
    await expect(page.getByText('Scan anywhere in view', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const hold = page.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' });
    await hold.focus();
    await hold.press('Space');
    await expect(hold).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    const positions = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ];
    const timings = [];
    for (const [i, position] of positions.entries()) {
      const request = page.waitForRequest(
        (r) => r.url().endsWith('/api/v1/scan/actions') && r.method() === 'POST',
      );
      const start = Date.now();
      await showBarcode(page, i, 0, false, position);
      await request;
      timings.push({ format: items[i]?.format, position, milliseconds: Date.now() - start });
      await expect(page.getByTestId('scan-result')).toContainText(`Camera ${items[i]?.format}`, {
        timeout: 8_000,
      });
      await expect(page.getByTestId('scan-result')).toContainText('Checked in');
      await showBarcode(page, -1);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await info.attach('off-center-decode-timings', {
      body: JSON.stringify(timings),
      contentType: 'application/json',
    });
  } finally {
    await api.dispose();
  }
});

test('camera permission denial and disconnect recover with Retry camera', async ({ page }) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  try {
    const { scanner, items } = await cameraFixture(api, orgId, 'barcode');
    await installCamera(
      page,
      items.map((i) => i.image),
      { permissionDenied: true },
    );
    await pairCamera(page, scanner.pairing.code);
    await page.getByRole('button', { name: 'Use camera', exact: true }).click();
    await expect(page.getByText('Camera access blocked', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { cameraTest: { denied: boolean } }).cameraTest.denied = false;
    });
    await page.getByRole('button', { name: 'Retry camera' }).click();
    await expect(page.getByText('Scan anywhere in view', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByText('Scan anywhere in view', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const track = (window as unknown as { cameraTest: { track: MediaStreamTrack } }).cameraTest
        .track;
      track.stop();
      track.dispatchEvent(new Event('ended'));
    });
    await expect(page.getByText('Camera unavailable', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry camera' }).click();
    await showBarcode(
      page,
      cameraFormats.findIndex((f) => f[0] === 'qr'),
    );
    await expect(page.getByTestId('scan-result')).toContainText('Camera qr');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
  } finally {
    await api.dispose();
  }
});

test('a decoder download failure offers recovery and lookup pauses camera reads', async ({
  page,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  try {
    const { scanner, items } = await cameraFixture(api, orgId);
    await installCamera(
      page,
      items.map((i) => i.image),
    );
    await page.route('**/*.wasm*', (route) => route.abort());
    await pairCamera(page, scanner.pairing.code);
    await expect(page.getByRole('button', { name: 'Retry camera' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('Camera reader unavailable. Use Look up.', { exact: true }),
    ).toBeVisible();
    await page.unroute('**/*.wasm*');
    await page.getByRole('button', { name: 'Retry camera' }).click();
    await expect(page.getByText('Scan anywhere in view', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await showBarcode(page, 0);
    const frame = await page.evaluate(
      () => (window as unknown as { cameraTest: { frames: number } }).cameraTest.frames,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { cameraTest: { frames: number } }).cameraTest.frames,
        ),
      )
      .toBeGreaterThan(frame + 10);
    const paused = await api.get(`/api/v1/scans?orgId=${orgId}&scannerId=${scanner.id}`);
    expect(paused.items).toHaveLength(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Camera qr');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
  } finally {
    await api.dispose();
  }
});
