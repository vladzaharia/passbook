import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { readReceipts } from '../retention/receipt-service.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  addEvents,
  endpointWithSecret,
  type Rig,
  reset,
  seedSecret,
  setupRig,
} from './deliver-test-fixtures.ts';
import { dailyWebhooks } from './jobs.ts';
import { ALL_TYPES, countOf } from './webhooks-test-fixtures.ts';

let rig: Rig;
const DAY = 86_400_000;

beforeAll(async () => {
  rig = await setupRig();
});

describe('daily retention', () => {
  it('purges by age: feed with its cascade, delivered rows, attempts, test sends and secrets', async () => {
    await reset(rig);
    const now = rig.kit.clock.now();
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId, eventTypes: ALL_TYPES });
    const pass = await rig.kit.pass();
    // An old event (40 days), written late: the feed row keeps the event time.
    await recordPassEvent(rig.kit.ctx, {
      orgId: rig.orgId,
      passId: pass.id,
      mode: 'live',
      kind: 'pass.voided',
      at: now - 40 * DAY,
    });
    await addEvents(rig, pass.id, 2);
    const feed = await all<{ seq: number; at: number; type: string }>(
      rig.db,
      'SELECT seq, at, type FROM event_feed WHERE pass_id = ? ORDER BY seq',
      [pass.id],
    );
    const old = feed.find((f) => f.at < now - 30 * DAY)?.seq as number;
    const [a, b] = feed.filter((f) => f.type === 'pass.updated').map((f) => f.seq) as [
      number,
      number,
    ];
    const attempt = (id: string, seq: number | null, at: number) =>
      run(
        rig.db,
        `INSERT INTO webhook_attempts (id, endpoint_id, org_id, mode, event_seq, attempt, trigger,
           duration_ms, at) VALUES (?, ?, ?, 'live', ?, 1, ?, 1, ?)`,
        [id, ep, rig.orgId, seq, seq === null ? 'test' : 'event', at],
      );
    await attempt('on-old-feed', old, now - 1);
    await attempt('old-attempt', a, now - 31 * DAY);
    await attempt('fresh-attempt', a, now - 29 * DAY);
    await attempt('old-test', null, now - 8 * DAY);
    await attempt('fresh-test', null, now - 6 * DAY);
    const deliver = (seq: number, ago: number) =>
      run(
        rig.db,
        `UPDATE webhook_deliveries SET state = 'delivered', finished_at = ?
         WHERE endpoint_id = ? AND event_seq = ?`,
        [now - ago, ep, seq],
      );
    await deliver(a, 8 * DAY);
    await deliver(b, 6 * DAY);
    await seedSecret(rig, { endpointId: ep, id: 'gone', value: 'x', expiresAt: now - 2 * DAY });
    await seedSecret(rig, { endpointId: ep, id: 'recent', value: 'x', expiresAt: now - DAY / 2 });
    // Expiry only moves earlier, and a second current secret is refused, so the live one stays.
    expect(await countOf(rig.db, 'webhook_endpoint_secrets', `endpoint_id = '${ep}'`)).toBe(3);

    await dailyWebhooks(rig.ctx);

    const ids = async (sql: string) =>
      (await all<{ k: string | number }>(rig.db, sql, [ep])).map((r) => r.k);
    // The 40-day feed row is gone, and its delivery and attempt went with it.
    expect(
      await ids('SELECT event_seq AS k FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY 1'),
    ).not.toContain(old);
    expect(await countOf(rig.db, 'event_feed', `seq = ${old}`)).toBe(0);
    expect(
      await ids('SELECT id AS k FROM webhook_attempts WHERE endpoint_id = ? ORDER BY id'),
    ).toEqual(['fresh-attempt', 'fresh-test']);
    // `delivered` after 7 days: the 8-day row is deleted, the 6-day row stays (and its feed row).
    const remaining = await ids(
      'SELECT event_seq AS k FROM webhook_deliveries WHERE endpoint_id = ?',
    );
    expect(remaining).not.toContain(a);
    expect(remaining).toContain(b);
    expect(await countOf(rig.db, 'event_feed', `seq = ${a}`)).toBe(1);
    const secrets = await ids(
      'SELECT id AS k FROM webhook_endpoint_secrets WHERE endpoint_id = ? ORDER BY id',
    );
    expect(secrets).not.toContain('gone');
    expect(secrets).toContain('recent');
    expect(secrets).toHaveLength(2);
  });
});

describe('retention plan', () => {
  const set = async (orgId: string, key: string, days: number) => {
    await run(
      rig.db,
      'INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value',
      [`org:${orgId}`, key, String(days)],
    );
    clearSettingsCache(rig.db);
  };
  /** A fresh org with a pass and one feed row `ago` days old. */
  const seed = async (ago: number, orgId?: string) => {
    const id = orgId ?? (await makeOrg(rig.kit.fx)).id;
    const pass = await rig.kit.pass({ orgId: id });
    await recordPassEvent(rig.kit.ctx, {
      orgId: id,
      passId: pass.id,
      mode: 'live',
      kind: 'pass.voided',
      at: rig.kit.clock.now() - ago * DAY,
    });
    const row = await all<{ seq: number }>(
      rig.db,
      "SELECT seq FROM event_feed WHERE pass_id = ? AND type = 'pass.voided'",
      [pass.id],
    );
    return { orgId: id, passId: pass.id, seq: row[0]?.seq as number };
  };
  const there = async (seq: number) => (await countOf(rig.db, 'event_feed', `seq = ${seq}`)) === 1;
  const hold = (orgId: string, passId: string | null) =>
    run(
      rig.db,
      "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)",
      [rig.kit.fx.ids.id(), orgId, passId],
    );
  const unhold = (orgId: string) =>
    run(
      rig.db,
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
      [orgId],
    );

  it('a shortened org setting purges earlier; the default org and its receipt are right', async () => {
    const mine = await seed(15);
    const theirs = await seed(15);
    await set(mine.orgId, 'retention.webhooksDays', 10);
    await dailyWebhooks(rig.ctx);
    expect(await there(mine.seq)).toBe(false);
    expect(await there(theirs.seq)).toBe(true);
    const receipts = await readReceipts(rig.ctx, mine.orgId, 'webhooks');
    expect(receipts.at(-1)?.receipt).toMatchObject({ policyDays: 10, deleted: 1 });
  });

  it('the shorter of the webhooks and events settings sets the feed', async () => {
    const a = await seed(15);
    await set(a.orgId, 'retention.eventsDays', 10);
    await dailyWebhooks(rig.ctx);
    expect(await there(a.seq)).toBe(false);
  });

  it('an org hold or a pass hold delays the purge until it is released', async () => {
    const org = await seed(15);
    await set(org.orgId, 'retention.webhooksDays', 10);
    await hold(org.orgId, null);
    const held = await seed(15);
    await set(held.orgId, 'retention.webhooksDays', 10);
    await hold(held.orgId, held.passId);
    const free = await seed(15, held.orgId);
    await dailyWebhooks(rig.ctx);
    expect(await there(org.seq)).toBe(true);
    expect(await there(held.seq)).toBe(true);
    expect(await there(free.seq)).toBe(false);
    await unhold(org.orgId);
    await dailyWebhooks(rig.ctx);
    expect(await there(org.seq)).toBe(false);
  });

  it('a floor wins over a shorter setting', async () => {
    const a = await seed(15);
    await set(a.orgId, 'retention.webhooksDays', 10);
    await run(
      rig.db,
      "INSERT INTO retention_floors (org_id, class, days, until) VALUES (?, 'webhooks', 20, ?)",
      [a.orgId, rig.kit.clock.now() + 7 * DAY],
    );
    await dailyWebhooks(rig.ctx);
    expect(await there(a.seq)).toBe(true);
  });

  it('keeps 30 days of feed for an org that set nothing', async () => {
    const young = await seed(29);
    const old = await seed(31);
    await dailyWebhooks(rig.ctx);
    expect(await there(young.seq)).toBe(true);
    expect(await there(old.seq)).toBe(false);
  });
});
