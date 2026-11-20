import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { clockedHub } from './clocked-hub-test-fixtures.ts';
import { liveAttachment, liveRingRow, scanHub } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { attach, workspace } from './repo-session-activity-authority-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

type Scanner = Awaited<ReturnType<ScanKit['scanner']>>;

async function actorOf(kit: ScanKit, scannerId: string) {
  const row = await getScanner(kit.env.DB, scannerId);
  if (!row) throw new Error('Missing scanner.');
  const scope = await readScannerScope(kit.env.DB, row, row.staffId);
  const actor = scannerActor(kit.ctx, row, row.mode, 'cookie', scope);
  await bindScanningSession(kit.ctx, actor);
  withRole(actor, null);
  return proofedScanActor(kit.ctx, actor);
}

/** The device socket of a scanner on the org's live hub; what it is sent is collected. */
async function connect(kit: ScanKit, scannerId: string) {
  const attachment = liveAttachment(kit.ctx, await actorOf(kit, scannerId), 'device');
  const response = await clockedHub(kit.ctx, kit.clock, kit.org.id, 'live').fetch(
    new Request('https://hub.test', {
      headers: { upgrade: 'websocket', 'x-pb-live': await sealLiveAttachment(kit.env, attachment) },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error('The device did not connect.');
  socket.accept();
  const messages: unknown[] = [];
  const closed: number[] = [];
  socket.addEventListener('message', (e) => {
    messages.push(JSON.parse(String(e.data)));
  });
  socket.addEventListener('close', (e) => {
    closed.push(e.code);
  });
  return { socket, messages, closed };
}

async function entryFrom(kit: ScanKit, scannerId: string) {
  const base: ScanLiveRow = {
    id: kit.ctx.ids.token(16),
    at: kit.clock.now(),
    scannerId,
    scannerName: 'Front desk',
    passId: null,
    holder: null,
    photoUrl: null,
    kind: 'refused',
    direction: null,
    label: 'Not accepted',
    presented: true,
  };
  const entry = await liveRingRow(kit.ctx, await actorOf(kit, scannerId), base, null, null);
  if (!entry) throw new Error('No ring entry.');
  return entry;
}

/** A kit on the wall clock (a hub alarm runs on it) with the credential keyset the sockets are sealed against. */
async function fresh() {
  const kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  kit.clock.advance(Date.now() - kit.clock.now());
  return kit;
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function inSession(kit: ScanKit): Promise<{ scanner: Scanner; sessionId: string }> {
  const scanner = await kit.scanner({});
  const sessionId = await workspace(kit, scanner, null);
  return { scanner, sessionId };
}

/** The pulse an operator device gets when its session is scanned in. It carries nothing; these are the fences. */
describe('the device pulse', () => {
  it('reaches the devices of the scanned session, and only them', async () => {
    const kit = await fresh();
    const a = await inSession(kit);
    const b = await inSession(kit);
    const socketA = await connect(kit, a.scanner.id);
    const socketB = await connect(kit, b.scanner.id);
    const hub = clockedHub(kit.ctx, kit.clock, kit.org.id, 'live');
    expect(
      await hub.publish({
        orgId: kit.org.id,
        mode: 'live',
        row: await entryFrom(kit, a.scanner.id),
      }),
    ).toBe(true);
    await wait();
    expect(socketA.messages).toEqual([{ pulse: 1 }]);
    expect(socketB.messages).toEqual([]);
    socketA.socket.close(1000);
    socketB.socket.close(1000);
  });

  it('carries no pass, name or id', async () => {
    const kit = await fresh();
    const a = await inSession(kit);
    const socket = await connect(kit, a.scanner.id);
    const hub = clockedHub(kit.ctx, kit.clock, kit.org.id, 'live');
    await hub.publish({ orgId: kit.org.id, mode: 'live', row: await entryFrom(kit, a.scanner.id) });
    await wait();
    expect(JSON.stringify(socket.messages)).not.toMatch(/Front desk|scannerId|passId|holder/);
    socket.socket.close(1000);
  });

  it('never crosses to another org: its hub refuses the row and its sockets hear nothing', async () => {
    const kit = await fresh();
    const a = await inSession(kit);
    const socket = await connect(kit, a.scanner.id);
    const other = await makeOrg(kit.fx);
    const foreign = scanHub(kit.ctx, other.id, 'live');
    expect(
      await foreign.publish({
        orgId: other.id,
        mode: 'live',
        now: kit.clock.now(),
        row: await entryFrom(kit, a.scanner.id),
      }),
    ).toBe(false);
    // The test-mode hub of the same org is another object too.
    expect(
      await scanHub(kit.ctx, kit.org.id, 'test').publish({
        orgId: kit.org.id,
        mode: 'test',
        now: kit.clock.now(),
        row: await entryFrom(kit, a.scanner.id),
      }),
    ).toBe(false);
    await wait();
    expect(socket.messages).toEqual([]);
    socket.socket.close(1000);
  });

  it('is not sent to a screen, and a row with no session reaches no device', async () => {
    const kit = await fresh();
    const a = await inSession(kit);
    const loose = await kit.scanner({});
    const socket = await connect(kit, a.scanner.id);
    const hub = clockedHub(kit.ctx, kit.clock, kit.org.id, 'live');
    const entry = await entryFrom(kit, loose.id);
    expect(entry.sessionId ?? null).toBeNull();
    await hub.publish({ orgId: kit.org.id, mode: 'live', row: entry });
    await wait();
    expect(socket.messages).toEqual([]);
    socket.socket.close(1000);
  });

  it('closes a revoked device instead of telling it', async () => {
    const kit = await fresh();
    const a = await inSession(kit);
    const watcher = await inSession(kit);
    const socket = await connect(kit, watcher.scanner.id);
    await kit.env.DB.prepare('UPDATE scanners SET revoked_at = ? WHERE id = ?')
      .bind(kit.clock.now(), watcher.scanner.id)
      .run();
    const hub = clockedHub(kit.ctx, kit.clock, kit.org.id, 'live');
    // The revoked device's own session is scanned in by a device that still works.
    const second = await kit.scanner({});
    await attach(kit, second, watcher.sessionId);
    await hub.publish({ orgId: kit.org.id, mode: 'live', row: await entryFrom(kit, second.id) });
    await wait();
    expect(socket.messages).toEqual([]);
    expect(socket.closed).toEqual([4409]);
    expect(a.sessionId).not.toBe(watcher.sessionId);
  });
});
