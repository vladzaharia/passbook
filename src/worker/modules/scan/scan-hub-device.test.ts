import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { scannerActor, withRole } from './actor.ts';
import { liveAttachment, liveRingRow } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { proofedScanActor } from './test-kit.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const orgId = () => f.kit.org.id;

/** A monitor screen watching every scanner of the org, opened on the hub. */
async function openScreen() {
  const device = await f.kit.scanner({ deviceRole: 'monitor' });
  await setSetupWatchStmt(f.kit.env.DB, orgId(), device.id, { scannerIds: [], allOrg: true }).run();
  const row = await getScanner(f.kit.env.DB, device.id);
  if (!row) throw new Error('Missing screen.');
  const scope = await readScannerScope(f.kit.env.DB, row, row.staffId);
  const actor = scannerActor(f.kit.ctx, row, row.mode, 'cookie', scope);
  await bindScanningSession(f.kit.ctx, actor);
  withRole(actor, null);
  const attachment = liveAttachment(f.kit.ctx, await proofedScanActor(f.kit.ctx, actor));
  const response = await f.hub().fetch(
    new Request('https://hub.test', {
      headers: {
        upgrade: 'websocket',
        'x-pb-live': await sealLiveAttachment(f.kit.env, attachment),
      },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error('The screen did not connect.');
  socket.accept();
  const closed: number[] = [];
  socket.addEventListener('close', (e) => {
    closed.push(e.code);
  });
  return { socket, closed };
}

describe('the device socket', () => {
  it('is opened by a scan-role device with as=device, and is not a screen', async () => {
    const door = await f.device('door');
    const monitor = await f.kit.scanner({ deviceRole: 'monitor' });
    const ok = await f.deviceGet(door, '/live?as=device');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ rows: [], cursor: null });
    // A screen cannot open a device socket, and a device cannot open a screen.
    const screen = await f.deviceGet(monitor, '/live?as=device');
    expect(screen.status).toBe(403);
    expect(await screen.json()).toMatchObject({ code: 'DEVICE_REQUIRED' });
    const asScreen = await f.deviceGet(door, '/live');
    expect(asScreen.status).toBe(403);
    expect(await asScreen.json()).toMatchObject({ code: 'SCREEN_REQUIRED' });
  });

  it('opens for a door too, so an override can reach the refusing door', async () => {
    const door = await f.device('door');
    const socket = await f.connect(door.id);
    expect(await f.hub().connected([door.id])).toEqual([door.id]);
    const sent = await f.hub().resolved({
      orgId: orgId(),
      mode: 'live',
      scannerId: door.id,
      resolved: { of: 'scan-1', outcome: 'ok', by: { staff: 'Sam', device: 'Desk' } },
    });
    expect(sent).toBe(1);
    await f.wait();
    expect(socket.messages).toEqual([
      { resolved: { of: 'scan-1', outcome: 'ok', by: { staff: 'Sam', device: 'Desk' } } },
    ]);
    socket.socket.close(1000);
  });

  it('carries no rows, and survives any number of screens', async () => {
    const desk = await f.device('desk');
    const device = await f.connect(desk.id);
    const screens = [
      await openScreen(),
      await openScreen(),
      await openScreen(),
      await openScreen(),
    ];
    const row = await f.kit.scanner({ templateIds: [f.tpl] });
    const source = await getScanner(f.kit.env.DB, row.id);
    if (!source) throw new Error('Missing source.');
    const scope = await readScannerScope(f.kit.env.DB, source, source.staffId);
    const actor = scannerActor(f.kit.ctx, source, source.mode, 'cookie', scope);
    await bindScanningSession(f.kit.ctx, actor);
    withRole(actor, null);
    const base: ScanLiveRow = {
      id: f.kit.ctx.ids.token(16),
      at: f.kit.clock.now(),
      scannerId: row.id,
      scannerName: 'Front door',
      passId: null,
      holder: null,
      photoUrl: null,
      kind: 'refused',
      direction: null,
      label: 'Not accepted',
      presented: true,
    };
    const entry = await liveRingRow(
      f.kit.ctx,
      await proofedScanActor(f.kit.ctx, actor),
      base,
      null,
      null,
    );
    if (!entry) throw new Error('No ring entry.');
    expect(await f.hub().publish({ orgId: orgId(), mode: 'live', row: entry })).toBe(true);
    await f.wait(50);
    expect(device.messages).toEqual([]);
    expect(device.closed).toEqual([]);
    expect(await f.hub().connected([desk.id])).toEqual([desk.id]);
    for (const s of screens) s.socket.close(1000);
    device.socket.close(1000);
  });

  it('keeps only the newest connection of one device', async () => {
    const desk = await f.device('desk');
    const [one, two, three] = [
      await f.connect(desk.id),
      await f.connect(desk.id),
      await f.connect(desk.id),
    ];
    await f.wait();
    expect(one.closed).toEqual([{ code: 4408, reason: 'Replaced' }]);
    expect(two.closed).toEqual([]);
    expect(three.closed).toEqual([]);
    three.socket.close(1000);
    two.socket.close(1000);
  });

  it('is read only', async () => {
    const desk = await f.device('desk');
    const device = await f.connect(desk.id);
    device.socket.send('{"enroll":{"id":"x","cancelled":true}}');
    await f.wait(50);
    expect(device.closed[0]?.code).toBe(1008);
  });

  it('is rung only for its own scanner, and reports who is connected', async () => {
    const a = await f.device('desk');
    const b = await f.device('desk');
    const idle = await f.device('desk');
    const [sa, sb] = [await f.connect(a.id), await f.connect(b.id)];
    expect(
      await f.hub().enroll({
        orgId: orgId(),
        mode: 'live',
        scannerId: a.id,
        enrollment: { id: 'e1', expiresAt: f.kit.clock.now() + 90_000 },
      }),
    ).toBe(1);
    await f.wait();
    expect(sa.messages).toHaveLength(1);
    expect(sb.messages).toEqual([]);
    expect(
      await f.hub().enroll({
        orgId: orgId(),
        mode: 'live',
        scannerId: idle.id,
        enrollment: { id: 'e2', cancelled: true },
      }),
    ).toBe(0);
    expect((await f.hub().connected([a.id, b.id, idle.id])).sort()).toEqual([a.id, b.id].sort());
    // A test-mode hub is another object: this scanner is not connected there.
    expect(
      await f.hub().stub.enroll({
        orgId: orgId(),
        mode: 'test',
        scannerId: a.id,
        enrollment: { id: 'e3', cancelled: true },
      }),
    ).toBe(0);
    sa.socket.close(1000);
    sb.socket.close(1000);
  });

  it('never rings a screen with a tag request', async () => {
    const screen = await openScreen();
    const monitor = await f.kit.scanner({ deviceRole: 'monitor' });
    expect(
      await f.hub().enroll({
        orgId: orgId(),
        mode: 'live',
        scannerId: monitor.id,
        enrollment: { id: 'e4', cancelled: true },
      }),
    ).toBe(0);
    screen.socket.close(1000);
  });

  it('is closed when the device is revoked', async () => {
    const desk = await f.device('desk');
    const device = await f.connect(desk.id);
    await f.kit.env.DB.prepare('UPDATE scanners SET revoked_at = ? WHERE id = ?')
      .bind(f.kit.clock.now(), desk.id)
      .run();
    expect(
      await f.hub().enroll({
        orgId: orgId(),
        mode: 'live',
        scannerId: desk.id,
        enrollment: { id: 'e5', expiresAt: f.kit.clock.now() + 90_000 },
      }),
    ).toBe(0);
    await f.wait();
    expect(device.closed[0]?.code).toBe(4409);
  });
});
