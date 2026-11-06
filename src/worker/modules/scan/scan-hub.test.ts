import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan, scanHub } from './live.ts';
import type { LiveAttachment } from './live-auth.ts';
import { getScanner } from './repo-device.ts';
import { setSetupWatchStmt } from './repo-setups.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Live membership', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});
async function screen(role: 'monitor' | 'customer', ids: string[], allOrg = false) {
  const device = await kit.scanner({ deviceRole: role, templateIds: [] });
  await setSetupWatchStmt(kit.env.DB, kit.org.id, device.id, { scannerIds: ids, allOrg }).run();
  const row = await getScanner(kit.env.DB, device.id);
  const attachment: LiveAttachment = {
    orgId: kit.org.id,
    mode: 'live',
    scannerId: device.id,
    role,
    tokenHash: row!.tokenHash!,
    revision: row!.updatedAt,
    expiresAt: Date.now() + 15 * 60_000,
  };
  return { ...device, attachment };
}
const hub = () => scanHub(kit.ctx, kit.org.id, 'live');
const row = (id: string, more: Partial<ScanLiveRow> = {}): ScanLiveRow => ({
  id: kit.ctx.ids.ordered(),
  at: Date.now(),
  scannerId: id,
  scannerName: 'Front door',
  passId: null,
  holder: 'Private Member',
  photoUrl: null,
  kind: 'ok',
  direction: 'in',
  label: 'Checked in',
  presented: true,
  ...more,
});
const publish = (body: ScanLiveRow) =>
  hub().publish({ orgId: kit.org.id, mode: 'live', row: body });
const next = (socket: WebSocket) =>
  new Promise<{ rows: ScanLiveRow[] }>((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    }),
  );

describe('live display hub', () => {
  it('publishes the public holder title and redacts references to another mode', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Source fixture is missing.');
    const actor = withRole(
      scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
      null,
    );
    const pass = await kit.scanPass(template, { memberName: 'Public Member' });
    const outcome = await act(kit.ctx, actor, {
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!outcome.display) throw new Error('The result fixture has no display.');
    outcome.display.identity.holder = 'STAFF-ONLY-TITLE';
    publishScan(kit.ctx, actor, outcome, 'camera');
    await kit.settle();
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([
      { holder: 'Public Member' },
    ]);
    const testPass = await kit.scanPass(
      template,
      { memberName: 'OTHER-MODE-TITLE' },
      { mode: 'test' },
    );
    const refused = await act(kit.ctx, actor, {
      input: codeOf(testPass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    publishScan(kit.ctx, actor, refused, 'camera');
    await kit.settle();
    const rows = (await hub().snapshot(monitor.attachment)).rows;
    expect(rows.find((row) => row.id === refused.scanId)).toMatchObject({
      holder: null,
      passId: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/STAFF-ONLY-TITLE|OTHER-MODE-TITLE/);
  });
  it('filters monitor catch-up by watched scanners and deduplicates retries', async () => {
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [a.id]);
    const body = row(a.id);
    await publish(body);
    await publish(body);
    await publish(row(b.id));
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([
      { scannerId: a.id, holder: 'Private Member' },
    ]);
    expect((await hub().snapshot(monitor.attachment, body.id)).rows).toHaveLength(0);
  });

  it('delivers a redacted customer verdict over a real hibernating WebSocket', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    const response = await hub().fetch(
      new Request('https://hub.test', {
        headers: {
          upgrade: 'websocket',
          'x-pb-live': JSON.stringify(customer.attachment),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await next(socket);
    try {
      const received = next(socket);
      await publish(
        row(source.id, { passId: kit.ctx.ids.id(), kind: 'refused', label: 'Private reason' }),
      );
      const verdict = await received;
      expect(verdict.rows).toMatchObject([
        { label: 'Please see the desk', holder: null, photoUrl: null, passId: null },
      ]);
      expect(JSON.stringify(verdict)).not.toMatch(/Private|Member|reason/);
      expect((await hub().snapshot(customer.attachment)).rows).toEqual([]);
      const closed = new Promise<number>((resolve) =>
        socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
      );
      expect(await hub().kick(customer.id)).toBe(1);
      expect(await closed).toBe(4409);
    } finally {
      socket.close(1000);
    }
  });

  it('never replays customer results and omits manual lookups', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    await publish(row(source.id, { presented: false }));
    expect((await hub().snapshot(customer.attachment)).rows).toEqual([]);
  });

  it('renders a permitted member photo with a monitor-bound grant', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(template);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    await publish(row(source.id, { passId: pass.id }));
    const snapshot = await hub().snapshot(monitor.attachment);
    const url = snapshot.rows[0]?.photoUrl ?? '';
    expect(url).toContain('/scan/live/passes/');
    const image = await kit.get(monitor.headers, url.replace('/api/v1/scan', ''));
    expect(image.status).toBe(200);
    const other = await screen('monitor', [source.id]);
    expect((await kit.get(other.headers, url.replace('/api/v1/scan', ''))).status).toBe(404);
  });

  it('rejects stale credentials and settings revisions before returning history', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    await publish(row(source.id));
    for (const patch of [{ tokenHash: 'wrong' }, { revision: -1 }, { expiresAt: 1 }])
      expect((await hub().snapshot({ ...monitor.attachment, ...patch })).rows).toHaveLength(0);
  });

  it('refuses tenant, mode and source mismatches at the object boundary', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const other = await makeOrg(kit.fx);
    await publish(row(source.id));
    await expect(
      hub().publish({ orgId: other.id, mode: 'live', row: row(source.id) }),
    ).resolves.toBe(false);
    await expect(
      hub().publish({ orgId: kit.org.id, mode: 'test', row: row(source.id) }),
    ).resolves.toBe(false);
    const foreign = await kit.scanner({ orgId: other.id });
    await expect(publish(row(foreign.id))).resolves.toBe(false);
  });
});
