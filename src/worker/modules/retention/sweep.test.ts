import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { dailyDelivery } from '../delivery/jobs.ts';
import { dailyEvents } from '../events/jobs.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { placeHold, releaseHold } from './holds.ts';
import { retentionPlan } from './plan.ts';
import { DAY } from './policy.ts';
import { readReceipts } from './receipt-service.ts';
import { deleteChunkStmt, receiptGate, type Scope } from './repo-sweep.ts';
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

describe('the delete is gated on its receipt, its eligibility and holds', () => {
  const cutoffs = () => ({ cutoff: now() - 90 * DAY, failedCutoff: now() - 90 * DAY });
  const platformScope = { kind: 'platform' as const, exclude: [] };
  const gated = async (
    o: { orgId: string },
    id: string,
    over: { scope?: Scope; receipt?: string; cutoff?: number } = {},
  ) => {
    const c =
      over.cutoff === undefined ? cutoffs() : { cutoff: over.cutoff, failedCutoff: over.cutoff };
    const [res] = await db().batch([
      deleteChunkStmt(
        db(),
        'events',
        over.scope ?? { kind: 'org', orgId: o.orgId },
        c,
        [id],
        over.receipt ?? receiptId,
      ),
    ]);
    return res?.meta.changes ?? 0;
  };
  let receiptId = '';
  beforeAll(async () => {
    const { writeReceipt } = await import('./receipt-service.ts');
    receiptId = (
      await writeReceipt(ctx(), { orgId: null, cls: 'gate-test', kind: 'sweep', deleted: 1 })
    ).id;
  });

  it('deletes an eligible row, and only with its receipt', async () => {
    const o = await orgWithEvents([100, 100 - 1]);
    expect(await gated(o, o.ids[100] as string, { receipt: 'no-such-receipt' })).toBe(0);
    expect(await present(o.ids[100] as string)).toBe(true);
    expect(await gated(o, o.ids[100] as string)).toBe(1);
  });

  it('refuses a row outside the scope, newer than the cutoff, or in test mode', async () => {
    const o = await orgWithEvents([100]);
    const other = await orgWithEvents([100]);
    expect(
      await gated(o, o.ids[100] as string, { scope: { kind: 'org', orgId: other.orgId } }),
    ).toBe(0);
    expect(
      await gated(o, o.ids[100] as string, { scope: { kind: 'platform', exclude: [o.orgId] } }),
    ).toBe(0);
    expect(await gated(o, o.ids[100] as string, { cutoff: now() - 200 * DAY })).toBe(0);
    const t = await orgWithEvents([100], 'test');
    expect(await gated(t, t.ids[100] as string)).toBe(0);
    expect(await present(o.ids[100] as string)).toBe(true);
    expect(await gated(o, o.ids[100] as string, { scope: platformScope })).toBe(1);
  });

  it('a hold placed after the rows were chosen stops the delete and the receipt', async () => {
    const o = await orgWithEvents([100]);
    const admin = await rk.platform();
    await placeHold(ctx(), o.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    expect(await gated(o, o.ids[100] as string)).toBe(0);
    const { prepareReceipt } = await import('./receipt-service.ts');
    const scope = { kind: 'org' as const, orgId: o.orgId };
    const p = await prepareReceipt(
      ctx(),
      { orgId: o.orgId, cls: 'events', kind: 'sweep', deleted: 1 },
      receiptGate('events', scope, cutoffs(), [o.ids[100] as string]),
    );
    const [r1, r2] = await db().batch([
      p.stmt,
      deleteChunkStmt(db(), 'events', scope, cutoffs(), [o.ids[100] as string], p.receipt.id),
    ]);
    expect([r1?.meta.changes, r2?.meta.changes]).toEqual([0, 0]);
    expect(await readReceipts(ctx(), o.orgId, 'events')).toEqual([]);
  });

  it('a second run over rows already gone writes no receipt', async () => {
    const o = await orgWithEvents([100]);
    await setRaw(o.orgId, 'retention.eventsDays', '30');
    await sweepClass(ctx(), 'events');
    await sweepClass(ctx(), 'events');
    const receipts = await readReceipts(ctx(), o.orgId, 'events');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receipt.deleted).toBe(1);
  });
});

describe('throughput', () => {
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const spy = () => ({
    ...ctx(),
    log: {
      ...ctx().log,
      warn: (event: string, fields: Record<string, unknown>) => void logs.push({ event, fields }),
    },
  });
  const many = (orgId: string, passId: string, n: number) =>
    run(
      db(),
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
       INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
       SELECT ? || '-' || i, ?, ?, 'live', 'page.opened', '{}', ? FROM s`,
      [n, rk.kit.fx.ids.id(), orgId, passId, now() - 400 * DAY],
    );

  it('a target that stops at its cap logs retention.backlog and finishes next time', async () => {
    const o = await orgWithEvents([]);
    await setRaw(o.orgId, 'retention.eventsDays', '30');
    await many(o.orgId, o.pass.id, 1001);
    logs.length = 0;
    const limits = { platformChunks: 50, orgChunks: 1, orgBudgetMs: 15_000 };
    const first = await sweepClass(spy(), 'events', limits);
    expect(first.orgs).toBe(1000);
    expect(logs.some((l) => l.event === 'retention.backlog' && l.fields.orgId === o.orgId)).toBe(
      true,
    );
    // The rotating cursor reaches the org again within a few visits.
    for (let i = 0; i < 8; i++) await sweepClass(spy(), 'events', limits);
    const left = await all(db(), 'SELECT 1 FROM pass_events WHERE org_id = ? AND at < ?', [
      o.orgId,
      now() - 30 * DAY,
    ]);
    expect(left).toEqual([]);
  });

  it('the org pass stops at its time budget, logs it and resumes after the last org visited', async () => {
    const a = await orgWithEvents([100]);
    const b = await orgWithEvents([100]);
    for (const o of [a, b]) await setRaw(o.orgId, 'retention.eventsDays', '30');
    logs.length = 0;
    await run(
      db(),
      "DELETE FROM settings WHERE scope = 'system' AND key = 'retention.cursor:events'",
    );
    await sweepClass(spy(), 'events', { platformChunks: 50, orgChunks: 50, orgBudgetMs: -1 });
    expect(logs.some((l) => l.event === 'retention.backlog' && l.fields.budget === true)).toBe(
      true,
    );
    // Only the first org in id order was visited: the cursor rests on it.
    const { readSystemValue } = await import('../settings/repo.ts');
    const plan = await retentionPlan(ctx(), 'events');
    if (plan.blocked) throw new Error('blocked');
    expect(await readSystemValue(db(), 'retention.cursor:events')).toBe(plan.special[0]?.orgId);
  });
});

describe('head object', () => {
  it('a head whose put failed is re-put on the next read, so the chain verifies again', async () => {
    const o = await orgWithEvents([100]);
    await setRaw(o.orgId, 'retention.eventsDays', '30');
    await sweepClass(ctx(), 'events');
    const key = `retention/receipts/${o.orgId}/events/${String(1).padStart(12, '0')}.json`;
    await rk.kit.env.BUCKET.delete(key);
    const receipts = await readReceipts(ctx(), o.orgId, 'events');
    expect(receipts.map((r) => r.verified)).toEqual([true]);
    expect(await rk.kit.env.BUCKET.head(key)).not.toBeNull();
  });
});

describe('org status', () => {
  it('a soft delete is refused by the database while a hold is active', async () => {
    const o = await rk.org();
    const admin = await rk.platform();
    const { id } = await placeHold(
      ctx(),
      o.orgId,
      { reason: 'inquiry' },
      { kind: 'platform', admin },
    );
    await expect(
      run(db(), "UPDATE orgs SET status = 'deleted' WHERE id = ?", [o.orgId]),
    ).rejects.toThrow(/legal hold/);
    await releaseHold(ctx(), o.orgId, id, { kind: 'platform', admin });
    await run(db(), "UPDATE orgs SET status = 'deleted' WHERE id = ?", [o.orgId]);
  });

  it('a soft-deleted org still follows its own longer value', async () => {
    const o = await orgWithEvents([100]);
    await setRaw(o.orgId, 'retention.eventsDays', '365');
    await run(db(), "UPDATE orgs SET status = 'deleted' WHERE id = ?", [o.orgId]);
    await sweepClass(ctx(), 'events');
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
