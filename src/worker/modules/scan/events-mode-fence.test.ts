import { beforeAll, describe, expect, it } from 'vitest';
import { type FakeAuth, fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createScannerStore } from './auth-store.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let fake: FakeAuth;
let kit: ScanKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupScanKit();
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
});
const call = (method: string, path: string, body?: unknown, mode?: 'test') =>
  Promise.resolve(
    app.request(
      `${ORIGIN}/api/v1/scan-events${path}`,
      {
        method,
        headers: {
          ...fake.admin(mode ? { mode } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      },
      kit.env,
    ),
  );
const eventsOf = (ids: string[]) =>
  all<{ id: string; event_id: string | null }>(
    kit.env.DB,
    `SELECT id, event_id FROM scanners WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids,
  );
const auditActions = async () =>
  (await all<{ action: string }>(kit.env.DB, 'SELECT action FROM audit_log')).map((r) => r.action);

describe('event writes are fenced to the console mode', () => {
  it('refuses assign, archive and edit from the other mode and changes nothing', async () => {
    const event = await kit.event({});
    const attached = await kit.scanner({ eventId: event.id });
    const free = await kit.scanner();
    expect(
      (await call('POST', `/${event.id}/scanners`, { scannerIds: [free.id] }, 'test')).status,
    ).toBe(404);
    expect((await call('POST', `/${event.id}/archive`, undefined, 'test')).status).toBe(404);
    expect((await call('PATCH', `/${event.id}`, { name: 'Hijacked' }, 'test')).status).toBe(404);
    const rows = await eventsOf([attached.id, free.id]);
    expect(rows.find((r) => r.id === attached.id)?.event_id).toBe(event.id);
    expect(rows.find((r) => r.id === free.id)?.event_id).toBeNull();
  });

  it('a scanner that changes mode before the commit aborts the whole assign', async () => {
    const event = await kit.event({});
    const a = await kit.scanner();
    const b = await kit.scanner();
    const { result, fired } = await beforeBatch(
      kit.env,
      /UPDATE scanners SET event_id/i,
      async (db) => void (await run(db, "UPDATE scanners SET mode = 'test' WHERE id = ?", [b.id])),
      () => call('POST', `/${event.id}/scanners`, { scannerIds: [a.id, b.id] }),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    expect((await eventsOf([a.id, b.id])).every((r) => r.event_id === null)).toBe(true);
    expect(await auditActions()).not.toContain('scan_event.assign');
  });

  it('an edit writes only the fields it names, so a concurrent rename survives', async () => {
    const event = await kit.event({});
    const { result, fired } = await beforeBatch(
      kit.env,
      /UPDATE scan_events SET/i,
      async (db) =>
        void (await run(db, "UPDATE scan_events SET name = 'Renamed meanwhile' WHERE id = ?", [
          event.id,
        ])),
      () => call('PATCH', `/${event.id}`, { capacity: 7 }),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(200);
    const row = await first<{ name: string; capacity: number }>(
      kit.env.DB,
      'SELECT name, capacity FROM scan_events WHERE id = ?',
      [event.id],
    );
    expect(row).toEqual({ name: 'Renamed meanwhile', capacity: 7 });
  });
});
