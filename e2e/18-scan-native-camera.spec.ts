import { expect, type Page, test } from '@playwright/test';
import { NATIVE_CAMERA_CODE } from '../tools/lib/camera-fixture.ts';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { pairCamera } from './helpers/camera.ts';
import { cloneMemberBarcode } from './helpers/member-barcode.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test('native getUserMedia camera video decodes and checks in without an injected read', async ({
  page,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  try {
    const template = await cloneMemberBarcode(api, orgId, uid('Native camera'));
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

type Sent = { version: number; op: string; id?: string; outcome?: string; reason?: string };

/** A fake app: answers the page's `hello` with `ready` listing `features`, and records what it is sent. */
async function fakeApp(page: Page, features: string[]) {
  await page.addInitScript((features) => {
    const native = {
      sent: [] as Record<string, unknown>[],
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(message: string) {
        const m = JSON.parse(message);
        this.sent.push(m);
        if (m.op === 'hello')
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({ version: 2, event: 'ready', features, capabilities: {} }),
            });
          }, 0);
      },
    };
    Object.assign(window, { PassBookNative: native });
    // The project's fake camera keeps reading its own code; these cases are about the app's reads.
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Camera off', 'NotAllowedError'));
  }, features);
}

const nativeScan = (page: Page, reads: [string, string][]) =>
  page.evaluate((reads) => {
    const bridge = (
      window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
    ).PassBookNative;
    for (const [id, value] of reads)
      bridge.onmessage({
        data: JSON.stringify({ version: 2, event: 'scan', source: 'barcode', id, value }),
      });
  }, reads);

const sentOps = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { PassBookNative: { sent: Sent[] } }).PassBookNative.sent,
  );

async function settleDoor(page: Page, features: string[]) {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const template = await cloneMemberBarcode(api, orgId, uid('Settle'));
  const release = await publishTemplateVersion(
    api,
    orgId,
    template.id,
    template.versions[0].version,
  );
  const codes: string[] = [];
  for (const n of [1, 2, 3]) {
    const memberId = uid(`SETTLE${n}`).toUpperCase();
    codes.push(memberId);
    await createPass(api, orgId, {
      templateId: template.id,
      release,
      memberId,
      holder: `Settle ${n}`,
    });
  }
  const scanner = await api.send('POST', '/api/v1/scanners', {
    orgId,
    name: uid('Settle door'),
    kind: 'device',
    accepts: { templateIds: [template.id] },
    timeZone: 'UTC',
    settings: { reader: 'barcode', lookup: true },
  });
  await fakeApp(page, features);
  await pairCamera(page, scanner.pairing.code);
  await expect.poll(async () => (await sentOps(page)).some((m) => m.op === 'hello')).toBe(true);
  return { api, codes };
}

test('an app listing scanSettle: duplicate is dropped, parked reads are answered, haptics go at v2', async ({
  page,
}) => {
  const { api, codes } = await settleDoor(page, ['scanAck', 'scanSettle']);
  try {
    await nativeScan(page, [['first', codes[0] as string]]);
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'first' && m.op === 'result'))
      .toMatchObject({ outcome: 'accepted' });
    await nativeScan(page, [['dup', codes[0] as string]]);
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'dup' && m.op !== 'scanAck'))
      .toMatchObject({ op: 'dropped', reason: 'duplicate' });
    await nativeScan(page, [
      ['a', codes[1] as string],
      ['b', codes[2] as string],
    ]);
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'a' && m.op === 'dropped'), {
        timeout: 20_000,
      })
      .toMatchObject({ reason: 'replaced' });
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'b' && m.op === 'result'), {
        timeout: 20_000,
      })
      .toMatchObject({ outcome: 'accepted' });
    const sent = await sentOps(page);
    expect(sent.some((m) => m.op === 'haptic' && m.version === 2)).toBe(true);
    for (const id of ['first', 'dup', 'a', 'b']) {
      const terminals = sent.filter(
        (m) => m.id === id && (m.op === 'result' || m.op === 'dropped'),
      );
      expect(terminals).toHaveLength(1);
    }
    expect(sent.some((m) => m.op === 'revise')).toBe(false);
  } finally {
    await api.dispose();
  }
});

test('an app without scanSettle: duplicate is result error, no revise, dropped or v2 haptic', async ({
  page,
}) => {
  const { api, codes } = await settleDoor(page, ['scanAck']);
  try {
    await nativeScan(page, [['first', codes[0] as string]]);
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'first' && m.op === 'result'))
      .toMatchObject({ outcome: 'accepted' });
    await nativeScan(page, [['dup', codes[0] as string]]);
    await expect
      .poll(async () => (await sentOps(page)).find((m) => m.id === 'dup' && m.op === 'result'))
      .toMatchObject({ outcome: 'error' });
    const sent = await sentOps(page);
    expect(sent.some((m) => m.op === 'revise' || m.op === 'dropped')).toBe(false);
    expect(sent.some((m) => m.op === 'haptic' && m.version === 2)).toBe(false);
  } finally {
    await api.dispose();
  }
});
