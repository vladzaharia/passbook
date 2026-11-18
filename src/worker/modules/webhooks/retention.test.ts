import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
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
