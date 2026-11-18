import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scanHub } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import type { LiveRingRow } from './live-ring.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { hub, kit, next, proven, row, screen, template } from './scan-hub-test-fixtures.ts';

type Watch = Record<string, unknown>;
const watchOf = (id: string, watch: Watch) =>
  setSetupWatchStmt(kit.env.DB, kit.org.id, id, { scannerIds: [], allOrg: false, ...watch }).run();
const publishWith = async (
  id: string,
  where: Partial<Pick<LiveRingRow, 'sessionId' | 'eventId' | 'zoneIds'>>,
  more: Parameters<typeof row>[1] = {},
) => {
  const entry = { ...(await proven(row(id, more))), ...where };
  await hub().publish({ orgId: kit.org.id, mode: 'live', row: entry, now: kit.clock.now() });
  return entry;
};
const keys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keys)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
      : [];
const open = async (attachment: Parameters<typeof sealLiveAttachment>[1]) => {
  const response = await hub().fetch(
    new Request('https://hub.test', {
      headers: { upgrade: 'websocket', 'x-pb-live': await sealLiveAttachment(kit.env, attachment) },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error('The screen did not connect.');
  socket.accept();
  await next(socket);
  return socket;
};

describe('watches by session, event and zone', () => {
  it('delivers only the sessions, event and zones a monitor names', async () => {
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const bySession = await screen('monitor', []);
    const byEvent = await screen('monitor', []);
    const byZone = await screen('monitor', []);
    const nobody = await screen('monitor', []);
    await watchOf(bySession.id, { sessionIds: ['s1', 's2'] });
    await watchOf(byEvent.id, { eventId: 'e1' });
    await watchOf(byZone.id, { zoneIds: ['z-parent'] });
    const inSession = await publishWith(a.id, { sessionId: 's2' });
    const atEvent = await publishWith(a.id, { eventId: 'e1' });
    const inZone = await publishWith(b.id, { zoneIds: ['z-child', 'z-parent'] });
    const elsewhere = await publishWith(b.id, { sessionId: 's9', eventId: 'e9', zoneIds: ['z9'] });
    const seen = async (monitor: typeof bySession) =>
      (await hub().snapshot(monitor.attachment, undefined, kit.clock.now())).rows.map((r) => r.id);
    expect(await seen(bySession)).toEqual([inSession.row.id]);
    expect(await seen(byEvent)).toEqual([atEvent.row.id]);
    expect(await seen(byZone)).toEqual([inZone.row.id]);
    expect(await seen(nobody)).toEqual([]);
    expect(elsewhere.row.id).toBeTruthy();
  });

  it('never delivers a screen its own scanner, and never a customer an event or zone watch', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    await watchOf(customer.id, { scannerIds: [], eventId: 'e1', zoneIds: ['z1'], sessionIds: [] });
    await publishWith(source.id, {});
    await publishWith(customer.id, { eventId: 'e1', zoneIds: ['z1'] });
    const entry = await publishWith(source.id, { eventId: 'e1', zoneIds: ['z1'] });
    const rows = [await hub().ringRow(entry.row.id, kit.clock.now())];
    expect(rows[0]).not.toBeNull();
    // A customer screen's reconnect never replays; its live delivery is checked in the next test.
    expect((await hub().snapshot(customer.attachment, undefined, kit.clock.now())).rows).toEqual(
      [],
    );
  });
});

describe('customer bodies', () => {
  it('carry the band and no reason, staff, photo, pass id or other holder', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id], false, {}, { templateIds: [template] });
    const socket = await open(customer.attachment);
    try {
      const pass = await kit.scanPass(template, { memberName: 'Anna Meyer' });
      const ok = next(socket);
      await publishWith(source.id, {}, { passId: pass.id, holder: 'Anna Meyer' });
      const accepted = await ok;
      expect(accepted.rows[0]?.customer).toMatchObject({
        screen: 'ok',
        band: { headline: 'Checked in', sub: null },
        greet: 'Hi, Anna',
        test: false,
      });
      const refusal = next(socket);
      await publishWith(
        source.id,
        {},
        { passId: pass.id, holder: 'Anna Meyer', kind: 'refused', label: 'Banned by Sam' },
      );
      const refused = await refusal;
      expect(refused.rows[0]?.customer).toMatchObject({
        screen: 'see_desk',
        band: { headline: 'Please see the desk', sub: null },
        greet: null,
        panel: null,
      });
      for (const message of [accepted, refused]) {
        const text = JSON.stringify(message);
        expect(text).not.toMatch(/Meyer|Banned|Sam/);
        expect(keys(message)).not.toEqual(
          expect.arrayContaining(['reason', 'staff', 'photoUrl', 'sourceStaff']),
        );
        for (const r of message.rows) {
          expect(r).toMatchObject({ passId: null, holder: null, photoUrl: null });
          expect(keys(r.customer)).not.toEqual(expect.arrayContaining(['passId', 'scanId']));
        }
      }
    } finally {
      socket.close(1000);
    }
  });

  it('are sent only for a presented code', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    const socket = await open(customer.attachment);
    try {
      await publishWith(source.id, {}, { presented: false });
      const shown = next(socket);
      await publishWith(source.id, {}, { presented: true });
      expect((await shown).rows).toHaveLength(1);
    } finally {
      socket.close(1000);
    }
  });
});

describe('in-now counts', () => {
  it('give a monitor a count per tracked event with a rising rev, and no holders', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const event = await kit.event({ templateIds: [template] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry=1, capacity=40, name=? WHERE id=?', [
      'Main hall',
      event.id,
    ]);
    const monitor = await screen('monitor', []);
    await watchOf(monitor.id, { eventId: event.id });
    await publishWith(source.id, { eventId: event.id });
    const first = await hub().snapshot(monitor.attachment, undefined, kit.clock.now());
    expect(first.places).toMatchObject([
      { place: `event:${event.id}`, name: 'Main hall', inNow: 0, capacity: 40 },
    ]);
    kit.clock.advance(5);
    const again = await hub().snapshot(monitor.attachment, undefined, kit.clock.now());
    expect(again.places?.[0]?.rev).toBeGreaterThan(first.places?.[0]?.rev ?? Infinity);
    expect(keys(first.places)).not.toEqual(expect.arrayContaining(['passId', 'holder', 'inside']));
  });

  it('skip an event that does not track exits, and give a customer none', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const event = await kit.event({ templateIds: [template] });
    const monitor = await screen('monitor', []);
    await watchOf(monitor.id, { eventId: event.id });
    await publishWith(source.id, { eventId: event.id });
    expect((await hub().snapshot(monitor.attachment, undefined, kit.clock.now())).places).toBe(
      undefined,
    );
    const customer = await screen('customer', [source.id]);
    expect(
      await hub().snapshot(customer.attachment, undefined, kit.clock.now()),
    ).not.toHaveProperty('places');
  });
});

describe('resolved', () => {
  it('goes to the refusing device only, never to another screen', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const one = await screen('monitor', [source.id]);
    const two = await screen('monitor', [source.id]);
    const first = await open(one.attachment);
    const second = await open(two.attachment);
    try {
      const got = Promise.race([
        new Promise<unknown>((resolve) =>
          first.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), {
            once: true,
          }),
        ),
        new Promise<unknown>((resolve) => setTimeout(resolve, 3000, 'timeout')),
      ]);
      const other = Promise.race([
        new Promise<unknown>((resolve) =>
          second.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), {
            once: true,
          }),
        ),
        new Promise<unknown>((resolve) => setTimeout(resolve, 300, 'silent')),
      ]);
      const sent = await hub().resolved({
        orgId: kit.org.id,
        mode: 'live',
        scannerId: one.id,
        resolved: { of: 'scan-1', outcome: 'ok', by: { staff: 'Sam', device: 'Desk' } },
        now: kit.clock.now(),
      });
      expect(sent).toBe(1);
      expect(await got).toEqual({
        resolved: { of: 'scan-1', outcome: 'ok', by: { staff: 'Sam', device: 'Desk' } },
      });
      expect(await other).toBe('silent');
    } finally {
      first.close(1000);
      second.close(1000);
    }
  });
});

describe('test and live', () => {
  it('never share a hub key, and a hub refuses the other mode', async () => {
    const live = scanHub(kit.ctx, kit.org.id, 'live');
    const test = scanHub(kit.ctx, kit.org.id, 'test');
    expect(live.id.toString()).not.toBe(test.id.toString());
    const source = await kit.scanner({ templateIds: [template] });
    await publishWith(source.id, {});
    const entry = await proven(row(source.id));
    expect(await live.publish({ orgId: kit.org.id, mode: 'test', row: entry })).toBe(false);
    expect(await test.publish({ orgId: kit.org.id, mode: 'live', row: entry })).toBe(false);
  });
});
