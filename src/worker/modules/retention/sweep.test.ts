import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { dailyDelivery } from '../delivery/jobs.ts';
import { dailyEvents } from '../events/jobs.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { placeHold, releaseHold } from './holds.ts';
import { DAY } from './policy.ts';
import { readReceipts } from './receipt-service.ts';
import { deleteChunkStmt } from './repo-sweep.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';
import { sweepClass } from './sweep.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const ctx = () => rk.kit.ctx;
const db = () => rk.kit.env.DB;
const now = () => rk.kit.clock.now();

const setRaw = async (orgId: string, key: string, json: string) => {
  await run(
    db(),
    'INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value',
    [`org:${orgId}`, key, json],
  );
  clearSettingsCache(db());
};

/** An org with one pass, and events at each age (days). */
async function orgWithEvents(ages: number[], mode: 'live' | 'test' = 'live') {
  const o = await rk.org();
  const pass = await rk.kit.pass({ orgId: o.orgId });
  const ids: Record<number, string> = {};
  for (const age of ages) {
    const id = rk.kit.fx.ids.id();
    ids[age] = id;
    await run(
      db(),
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, ?, 'page.opened', '{}', ?)`,
      [id, o.orgId, pass.id, mode, now() - age * DAY],
    );
  }
  return { ...o, pass, ids };
}
const present = async (id: string) =>
  (await all(db(), 'SELECT 1 FROM pass_events WHERE id = ?', [id])).length === 1;

describe('events sweep', () => {
  it('each org follows its own value; rows exactly at the cutoff stay', async () => {
    const a = await orgWithEvents([100, 90, 10]);
    const b = await orgWithEvents([100, 40, 10]);
    const c = await orgWithEvents([100, 40]);
    await setRaw(b.orgId, 'retention.eventsDays', '30');
    await setRaw(c.orgId, 'retention.eventsDays', '365');
    await sweepClass(ctx(), 'events');
    expect(await present(a.ids[100] as string)).toBe(false);
    expect(await present(a.ids[90] as string)).toBe(true);
    expect(await present(a.ids[10] as string)).toBe(true);
    expect(await present(b.ids[100] as string)).toBe(false);
    expect(await present(b.ids[40] as string)).toBe(false);
    expect(await present(b.ids[10] as string)).toBe(true);
    expect(await present(c.ids[100] as string)).toBe(true);
    expect(await present(c.ids[40] as string)).toBe(true);
  });

  it('writes a receipt per org and for the platform pass, and the chains verify', async () => {
    const b = await orgWithEvents([100, 40]);
    await setRaw(b.orgId, 'retention.eventsDays', '30');
    await sweepClass(ctx(), 'events');
    const org = await readReceipts(ctx(), b.orgId, 'events');
    expect(org).toHaveLength(1);
    expect(org[0]).toMatchObject({
      verified: true,
      receipt: { deleted: 2, policyDays: 30, kind: 'sweep' },
    });
    expect((await readReceipts(ctx(), null, 'events')).every((r) => r.verified)).toBe(true);
  });

  it('writes no receipt when nothing was deleted', async () => {
    const b = await orgWithEvents([5]);
    await setRaw(b.orgId, 'retention.eventsDays', '30');
    await sweepClass(ctx(), 'events');
    expect(await readReceipts(ctx(), b.orgId, 'events')).toEqual([]);
  });

  it('leaves test-mode rows to the test window', async () => {
    const t = await orgWithEvents([100], 'test');
    await sweepClass(ctx(), 'events');
    expect(await present(t.ids[100] as string)).toBe(true);
    await dailyEvents(ctx());
    expect(await present(t.ids[100] as string)).toBe(false);
  });

  it('skips an invalid org value and a held org; a released hold deletes again', async () => {
    const bad = await orgWithEvents([100]);
    await setRaw(bad.orgId, 'retention.eventsDays', '1');
    const held = await orgWithEvents([100]);
    const admin = await rk.platform();
    const { id } = await placeHold(
      ctx(),
      held.orgId,
      { reason: 'inquiry' },
      { kind: 'platform', admin },
    );
    await sweepClass(ctx(), 'events');
    expect(await present(bad.ids[100] as string)).toBe(true);
    expect(await present(held.ids[100] as string)).toBe(true);
    await releaseHold(ctx(), held.orgId, id, { kind: 'platform', admin });
    await sweepClass(ctx(), 'events');
    expect(await present(held.ids[100] as string)).toBe(false);
  });

  it('a pass hold keeps that pass only', async () => {
    const o = await orgWithEvents([100]);
    const other = await rk.kit.pass({ orgId: o.orgId });
    const otherEvent = rk.kit.fx.ids.id();
    await run(
      db(),
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, 'live', 'page.opened', '{}', ?)`,
      [otherEvent, o.orgId, other.id, now() - 100 * DAY],
    );
    const admin = await rk.platform();
    await placeHold(
      ctx(),
      o.orgId,
      { passId: o.pass.id, reason: 'dispute' },
      { kind: 'platform', admin },
    );
    await sweepClass(ctx(), 'events');
    expect(await present(o.ids[100] as string)).toBe(true);
    expect(await present(otherEvent)).toBe(false);
  });

  it('a suspended org is swept on time', async () => {
    const o = await orgWithEvents([100]);
    await run(db(), "UPDATE orgs SET status = 'suspended' WHERE id = ?", [o.orgId]);
    await sweepClass(ctx(), 'events');
    expect(await present(o.ids[100] as string)).toBe(false);
  });

  it('a blocked class (invalid platform value) deletes nothing', async () => {
    const o = await orgWithEvents([400]);
    await run(
      db(),
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'retention.eventsDays', '1', 1)",
    );
    clearSettingsCache(db());
    expect(await sweepClass(ctx(), 'events')).toEqual({ platform: 0, orgs: 0 });
    expect(await present(o.ids[400] as string)).toBe(true);
    await run(
      db(),
      "DELETE FROM settings WHERE scope = 'platform' AND key = 'retention.eventsDays'",
    );
    clearSettingsCache(db());
  });
});

describe('the delete is gated on its receipt and on holds', () => {
  it('deletes nothing when the receipt is not in the batch', async () => {
    const o = await orgWithEvents([100]);
    const rowid =
      (
        await all<{ rowid: number }>(db(), 'SELECT rowid FROM pass_events WHERE id = ?', [
          o.ids[100],
        ])
      )[0]?.rowid ?? 0;
    const [res] = await db().batch([deleteChunkStmt(db(), 'events', [rowid], 'no-such-receipt')]);
    expect(res?.meta.changes).toBe(0);
    expect(await present(o.ids[100] as string)).toBe(true);
  });

  it('a hold placed after the rows were chosen still stops the delete', async () => {
    const o = await orgWithEvents([100]);
    const rowid =
      (
        await all<{ rowid: number }>(db(), 'SELECT rowid FROM pass_events WHERE id = ?', [
          o.ids[100],
        ])
      )[0]?.rowid ?? 0;
    const admin = await rk.platform();
    await placeHold(ctx(), o.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    const { writeReceipt } = await import('./receipt-service.ts');
    const r = await writeReceipt(ctx(), {
      orgId: null,
      cls: 'gate-test',
      kind: 'sweep',
      deleted: 1,
    });
    const [res] = await db().batch([deleteChunkStmt(db(), 'events', [rowid], r.id)]);
    expect(res?.meta.changes).toBe(0);
    expect(await present(o.ids[100] as string)).toBe(true);
  });
});

describe('delivery sweep', () => {
  const add = (orgId: string, passId: string, id: string, state: string, age: number) =>
    run(
      db(),
      `INSERT INTO outbox (id, org_id, kind, pass_id, state, created_at, finished_at) VALUES (?, ?, 'push', ?, ?, ?, ?)`,
      [id, orgId, passId, state, now() - age * DAY, now() - age * DAY],
    );
  const has = async (id: string) =>
    (await all(db(), 'SELECT 1 FROM outbox WHERE id = ?', [id])).length === 1;

  it('sent rows follow the org value; failed rows keep at least 90 days', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId });
    await setRaw(o.orgId, 'retention.deliveryDays', '7');
    await add(o.orgId, pass.id, 'x-old-sent', 'sent', 8);
    await add(o.orgId, pass.id, 'x-new-sent', 'sent', 6);
    await add(o.orgId, pass.id, 'x-mid-failed', 'failed', 60);
    await add(o.orgId, pass.id, 'x-old-failed', 'failed', 91);
    await dailyDelivery(ctx());
    expect(await has('x-old-sent')).toBe(false);
    expect(await has('x-new-sent')).toBe(true);
    expect(await has('x-mid-failed')).toBe(true);
    expect(await has('x-old-failed')).toBe(false);
  });
});
