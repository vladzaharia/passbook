import { expect, test } from '@playwright/test';
import { NATIVE_CAMERA_CODE } from '../tools/lib/camera-fixture.ts';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { pairCamera } from './helpers/camera.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test('native getUserMedia camera video decodes and checks in without an injected read', async ({
  page,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  try {
    const template = await api.send(
      'POST',
      `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
      { orgId, name: uid('Native camera') },
    );
    const release = await publishTemplateVersion(
      api,
      orgId,
      template.id,
      template.versions[0].version,
    );
    const pass = await createPass(api, orgId, {
      templateId: template.id,
      release,
      memberId: NATIVE_CAMERA_CODE,
      holder: 'Native Camera Guest',
    });
    const scanner = await api.send('POST', '/api/v1/scanners', {
      orgId,
      name: uid('Native camera door'),
      kind: 'device',
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
    });
    await pairCamera(page, scanner.pairing.code);
    await expect(page.getByTestId('scan-result')).toContainText('Native Camera Guest', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia.toString())).toContain(
      '[native code]',
    );
    const tracks = await page
      .locator('video')
      .evaluate((video) =>
        ((video as HTMLVideoElement).srcObject as MediaStream)
          .getVideoTracks()
          .map((t) => ({ state: t.readyState, settings: t.getSettings() })),
      );
    expect(tracks[0]).toMatchObject({ state: 'live', settings: { width: 640, height: 480 } });
    const scans = await api.get(`/api/v1/scans?orgId=${orgId}&scannerId=${scanner.id}`);
    expect(scans.items).toMatchObject([{ passId: pass.id, outcome: 'ok', method: 'camera' }]);
  } finally {
    await api.dispose();
  }
});
