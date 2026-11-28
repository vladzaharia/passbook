import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { DAY } from '../retention/policy.ts';
import { writeReceipt } from '../retention/receipt-service.ts';
import { deleteChunkStmt, selectChunk } from '../retention/repo-sweep.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { usagePeriods } from './jobs-periods.ts';
import { periodOf } from './periods.ts';
import { orgsDue } from './repo-daily.ts';
import { HORIZON_MS, syncOrgUsage, usageForMonth } from './usage-daily.ts';

const NOV15 = Date.UTC(2026, 10, 15, 20, 0, 0);

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const kit = () => rk.kit;
const db = () => rk.kit.env.DB;

const daily = (orgId: string, meter: string) =>
  all<{ local_day: string; quantity: number; utc_fallback: number }>(
    db(),
    'SELECT local_day, quantity, utc_fallback FROM usage_daily WHERE org_id = ? AND meter = ? ORDER BY local_day',
    [orgId, meter],
  );

async function freshOrg(zone?: string) {
  const o = await rk.org();
  if (zone) {
    await run(
      db(),
      `INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', ?, 1)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      [`org:${o.orgId}`, JSON.stringify(zone)],
    );
    clearSettingsCache(db());
  }
  kit().clock.set(NOV15);
  await syncOrgUsage(kit().ctx, o.orgId);
  return o;
}

const addEmail = async (orgId: string, passId: string | null, state = 'pending') => {
  const id = kit().fx.ids.id();
  await run(
    db(),
    `INSERT INTO outbox (id, org_id, kind, pass_id, state, created_at) VALUES (?, ?, 'email', ?, ?, ?)`,
    [id, orgId, passId, state, kit().clock.now()],
  );
  return id;
};
const setState = (id: string, state: string) =>
  run(db(), 'UPDATE outbox SET state = ?, finished_at = ? WHERE id = ?', [
    state,
    kit().clock.now(),
    id,
  ]);

/** Copies a pass row once per id, as a bulk create would insert rows. */
async function clonePasses(seedId: string, ids: string[]) {
  const cols = (
    await all<{ name: string }>(db(), "SELECT name FROM pragma_table_info('passes')")
  ).map((c) => c.name);
  const unique: Record<string, string> = {
    id: 'j.value',
    serial: "'s-' || j.value",
    download_token: "'h1:' || j.value",
    object_key: "'k-' || j.value",
    scan_code: 'NULL',
    barcode_hash: 'NULL',
    lookup_hash: 'NULL',
    external_id: 'NULL',
  };
  const select = cols.map((c) => unique[c] ?? `p.${c}`).join(', ');
  await run(
    db(),
    `INSERT INTO passes (${cols.join(', ')}) SELECT ${select} FROM json_each(?) j, passes p WHERE p.id = ?`,
    [JSON.stringify(ids), seedId],
  );
}

describe('usage counters', () => {
  it('fills the period and the local days, then counts a Live pass on its local day', async () => {
    const o = await freshOrg();
    const p = await first<{ time_zone: string; month: string }>(
      db(),
      'SELECT time_zone, month FROM usage_periods WHERE org_id = ?',
      [o.orgId],
    );
    expect(p).toEqual({ time_zone: 'America/Los_Angeles', month: '2026-11' });
    // 20:00Z on the 15th is noon in Los Angeles; 03:00Z on the 16th is still the 15th there.
    await kit().pass({ orgId: o.orgId });
    kit().clock.set(Date.UTC(2026, 10, 16, 3, 0, 0));
    await syncOrgUsage(kit().ctx, o.orgId);
    await kit().pass({ orgId: o.orgId });
    expect(await daily(o.orgId, 'passes_issued')).toEqual([
      { local_day: '2026-11-15', quantity: 2, utc_fallback: 0 },
    ]);
    expect(await usageForMonth(kit().ctx, o.orgId, 'passes_issued', '2026-11')).toBe(2);
  });

  it('flags a count made before the day bounds existed and uses the UTC date', async () => {
    const o = await rk.org();
    kit().clock.set(NOV15);
    await kit().pass({ orgId: o.orgId });
    expect(await daily(o.orgId, 'passes_issued')).toEqual([
      { local_day: '2026-11-15', quantity: 1, utc_fallback: 1 },
    ]);
  });

  it('ignores Test passes', async () => {
    const o = await freshOrg();
    await kit().pass({ orgId: o.orgId, mode: 'test' });
    expect(await daily(o.orgId, 'passes_issued')).toEqual([]);
  });

  it('counts a 5,000-row bulk create as 5,000', async () => {
    const o = await freshOrg();
    const seed = await kit().pass({ orgId: o.orgId });
    await run(db(), 'DELETE FROM usage_daily WHERE org_id = ?', [o.orgId]);
    await clonePasses(
      seed.id,
      Array.from({ length: 5000 }, (_, i) => `bulk-${i}`),
    );
    expect(await usageForMonth(kit().ctx, o.orgId, 'passes_issued', '2026-11')).toBe(5000);
  });

  it('counts nothing for the replacement of an identity move or for an in-place change', async () => {
    const o = await freshOrg();
    const old = await kit().pass({ orgId: o.orgId });
    await run(db(), 'DELETE FROM usage_daily WHERE org_id = ?', [o.orgId]);
    // A move row fixes the replacement's id when it is planned, before the pass exists.
    await run(
      db(),
      `INSERT INTO pass_moves (id, op_id, org_id, mode, from_identity_id, to_identity_id, old_pass_id, new_pass_id,
         created_at, updated_at) VALUES ('mv1', 'op1', ?, 'live', 'a', 'b', ?, 'moved-1', 1, 1)`,
      [o.orgId, old.id],
    );
    await clonePasses(old.id, ['moved-1']);
    await run(db(), 'UPDATE passes SET modified_at = modified_at + 1 WHERE id = ?', [old.id]);
    expect(await daily(o.orgId, 'passes_issued')).toEqual([]);
    await clonePasses(old.id, ['plain-1']);
    expect(await usageForMonth(kit().ctx, o.orgId, 'passes_issued', '2026-11')).toBe(1);
  });

  it('counts an email once when it is sent, and not when cancelled or failed', async () => {
    const o = await freshOrg();
    const pass = await kit().pass({ orgId: o.orgId });
    const sent = await addEmail(o.orgId, pass.id);
    const cancelled = await addEmail(o.orgId, pass.id);
    const failed = await addEmail(o.orgId, pass.id);
    await setState(cancelled, 'cancelled');
    await setState(failed, 'failed');
    expect(await daily(o.orgId, 'emails')).toEqual([]);
    await setState(sent, 'sent');
    await setState(sent, 'sent');
    expect(await daily(o.orgId, 'emails')).toEqual([
      { local_day: '2026-11-15', quantity: 1, utc_fallback: 0 },
    ]);
  });

  it('does not count an email of a Test pass', async () => {
    const o = await freshOrg();
    const pass = await kit().pass({ orgId: o.orgId, mode: 'test' });
    await setState(await addEmail(o.orgId, pass.id), 'sent');
    expect(await daily(o.orgId, 'emails')).toEqual([]);
  });
});

describe('usage periods', () => {
  it('applies a zone change from the next month', async () => {
    const o = await freshOrg('America/Los_Angeles');
    await run(
      db(),
      `UPDATE settings SET value = '"Europe/Berlin"' WHERE scope = ? AND key = 'org.timeZone'`,
      [`org:${o.orgId}`],
    );
    clearSettingsCache(db());
    await syncOrgUsage(kit().ctx, o.orgId);
    const zones = () =>
      all<{ month: string; time_zone: string }>(
        db(),
        'SELECT month, time_zone FROM usage_periods WHERE org_id = ? ORDER BY start_ms',
        [o.orgId],
      );
    expect(await zones()).toEqual([{ month: '2026-11', time_zone: 'America/Los_Angeles' }]);
    kit().clock.set(Date.UTC(2026, 10, 30, 12, 0, 0));
    await syncOrgUsage(kit().ctx, o.orgId);
    expect(await zones()).toEqual([
      { month: '2026-11', time_zone: 'America/Los_Angeles' },
      { month: '2026-12', time_zone: 'Europe/Berlin' },
    ]);
    const nov = periodOf('2026-11', 'America/Los_Angeles');
    const dec = await first<{ start_ms: number; end_ms: number }>(
      db(),
      "SELECT start_ms, end_ms FROM usage_periods WHERE org_id = ? AND month = '2026-12'",
      [o.orgId],
    );
    expect(dec?.start_ms).toBe(nov.endMs);
    expect(dec?.end_ms).toBe(periodOf('2027-01', 'Europe/Berlin').startMs);
  });

  it('works through at most 50 orgs a minute and settles', async () => {
    await run(db(), 'DELETE FROM usage_periods');
    kit().clock.set(NOV15);
    const total = (await all(db(), 'SELECT 1 FROM orgs WHERE closed_at IS NULL')).length;
    await usagePeriods(kit().ctx);
    const done = (await all(db(), 'SELECT DISTINCT org_id FROM usage_periods')).length;
    expect(done).toBe(Math.min(total, 50));
    for (let i = 0; i < Math.ceil(total / 50); i++) await usagePeriods(kit().ctx);
    expect(await orgsDue(db(), NOV15, HORIZON_MS)).toEqual([]);
  });
});

describe('retention guard', () => {
  const cutoffs = (cutoff: number) => ({ cutoff, failedCutoff: cutoff });
  const scope = (orgId: string) => ({ kind: 'org', orgId }) as const;
  const sweep = async (orgId: string, cls: 'events' | 'delivery', cutoff: number) => {
    const ids = await selectChunk(db(), cls, scope(orgId), cutoffs(cutoff));
    if (ids.length === 0) return 0;
    const receipt = await writeReceipt(kit().ctx, {
      orgId,
      cls,
      kind: 'sweep',
      deleted: ids.length,
    });
    const [res] = await db().batch([
      deleteChunkStmt(db(), cls, scope(orgId), cutoffs(cutoff), ids, receipt.id),
    ]);
    return res?.meta.changes ?? 0;
  };

  it('keeps metered events and sent email rows across a month end, then lets them go', async () => {
    const o = await freshOrg();
    const pass = await kit().pass({ orgId: o.orgId });
    const at = Date.UTC(2026, 10, 20, 12, 0, 0);
    kit().clock.set(at);
    const seen = (id: string) => first(db(), 'SELECT 1 AS x FROM pass_events WHERE id = ?', [id]);
    const ev = async (kind: string) => {
      const id = kit().fx.ids.id();
      await run(
        db(),
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, 'live', ?, '{}', ?)`,
        [id, o.orgId, pass.id, kind, at],
      );
      return id;
    };
    const metered = await ev('device.registered');
    const other = await ev('page.opened');
    const mail = await addEmail(o.orgId, pass.id);
    await setState(mail, 'sent');

    // Past the 90 day cutoff and past the November month end: December is still open, so the rows stay.
    kit().clock.set(Date.UTC(2026, 11, 5, 12, 0, 0));
    await syncOrgUsage(kit().ctx, o.orgId);
    const cutoff = at + DAY;
    await sweep(o.orgId, 'events', cutoff);
    await sweep(o.orgId, 'delivery', cutoff);
    expect(await seen(metered)).not.toBeNull();
    expect(await seen(other)).toBeNull();
    expect(await first(db(), 'SELECT 1 AS x FROM outbox WHERE id = ?', [mail])).not.toBeNull();

    // December has closed: the recount window of November is over.
    kit().clock.set(Date.UTC(2027, 0, 2, 12, 0, 0));
    await syncOrgUsage(kit().ctx, o.orgId);
    await sweep(o.orgId, 'events', cutoff);
    await sweep(o.orgId, 'delivery', cutoff);
    expect(await seen(metered)).toBeNull();
    expect(await first(db(), 'SELECT 1 AS x FROM outbox WHERE id = ?', [mail])).toBeNull();
  });
});
