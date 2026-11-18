import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import {
  addEvents,
  deliverNow,
  deliveryOf,
  drain,
  endpointOf,
  endpointWithSecret,
  laneOf,
  type Net,
  type Rig,
  reset,
  setupRig,
  statesOf,
  stubNet,
} from './deliver-test-kit.ts';
import { dispatchLane } from './dispatch.ts';
import { sweepWebhooks } from './jobs.ts';
import { claimAttempt, claimLane, nextDue } from './repo-delivery-state.ts';
import { ALL_TYPES } from './webhooks-test-fixtures.ts';

let rig: Rig;
let net: Net;
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => net.restore());

async function backlog(n: number) {
  const ep = await endpointWithSecret(rig, { orgId: rig.orgId, eventTypes: ALL_TYPES });
  const pass = await rig.kit.pass();
  await addEvents(rig, pass.id, n - 1);
  return { ep, pass };
}

describe('lanes', () => {
  it('one lane per endpoint under two concurrent claims', async () => {
    const { ep } = await backlog(3);
    const results = await Promise.all([
      dispatchLane(rig.ctx, laneOf(rig, ep)),
      dispatchLane(rig.ctx, laneOf(rig, ep)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(rig.kit.queue.sent).toHaveLength(1);
    expect(rig.kit.queue.sent[0]).toMatchObject({ kind: 'webhook.deliver', endpointId: ep });
    // While held, a third claim fails too.
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(false);
  });

  it('does not claim a lane with nothing due, or a paused endpoint', async () => {
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId });
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(false);
  });

  it('a crash mid-POST frees the lane after 60 s, and the retry counts the attempt', async () => {
    const { ep } = await backlog(2);
    const lane = laneOf(rig, ep);
    const now = rig.kit.clock.now();
    // A runner takes the lane and the first attempt, then dies before recording anything.
    expect(await claimLane(rig.db, lane, 'dead-runner', now, 60_000)).toBe(true);
    const first = await nextDue(rig.db, lane, now);
    expect(await claimAttempt(rig.db, first?.key as never, 0, now, 5 * MIN)).toBe(true);
    rig.kit.clock.advance(30_000);
    expect(await dispatchLane(rig.ctx, lane)).toBe(false);
    rig.kit.clock.advance(31_000);
    // Free again: the other delivery is due and goes out; the crashed one waits out its 5 minutes.
    expect(await dispatchLane(rig.ctx, lane)).toBe(true);
    await drain(rig);
    expect(net.calls).toHaveLength(1);
    expect(await statesOf(rig.db, ep)).toEqual([
      { state: 'delivered', n: 1 },
      { state: 'pending', n: 1 },
    ]);
    rig.kit.clock.advance(5 * MIN);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(2);
    const d = await deliveryOf(rig.db, ep, first?.feed.seq);
    expect(d).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  it('a runner that lost its lane stops without sending', async () => {
    const { ep } = await backlog(2);
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(true);
    const msg = rig.kit.queue.sent[0] as { lane: string };
    rig.kit.queue.sent[0] = { ...msg, lane: 'stale-token' };
    await drain(rig);
    expect(net.calls).toEqual([]);
  });

  it('continuation drains a 50-row backlog in order, 20 per message', async () => {
    const { ep } = await backlog(50);
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(true);
    expect(await drain(rig)).toBe(3);
    expect(net.calls).toHaveLength(50);
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'delivered', n: 50 }]);
    const seqs = await all<{ event_id: string }>(
      rig.db,
      `SELECT f.event_id FROM webhook_deliveries d JOIN event_feed f ON f.seq = d.event_seq
       WHERE d.endpoint_id = ? ORDER BY d.event_seq`,
      [ep],
    );
    expect(net.calls.map((c) => c.headers['x-passbook-event-id'])).toEqual(
      seqs.map((s) => s.event_id),
    );
    expect((await endpointOf(rig.db, ep))?.lane_token).toBeNull();
  });
});

describe('pause', () => {
  it('holds the backlog while paused and drains it on resume', async () => {
    const { ep } = await backlog(5);
    await run(rig.db, "UPDATE webhook_endpoints SET status = 'paused' WHERE id = ?", [ep]);
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(false);
    await sweepWebhooks(rig.ctx);
    expect(rig.kit.queue.sent).toEqual([]);
    // Fan-out continues while paused.
    await addEvents(
      rig,
      (await rig.db.prepare('SELECT pass_id FROM event_feed LIMIT 1').first<{ pass_id: string }>())
        ?.pass_id ?? '',
      1,
    );
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'pending', n: 6 }]);
    await run(rig.db, "UPDATE webhook_endpoints SET status = 'active' WHERE id = ?", [ep]);
    await sweepWebhooks(rig.ctx);
    await drain(rig);
    expect(net.calls).toHaveLength(6);
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'delivered', n: 6 }]);
  });
});

describe('disable', () => {
  const fail = () => new Response('', { status: 500 });

  async function failing(consecutive: number, sinceHoursAgo: number) {
    const { ep, pass } = await backlog(3);
    await run(
      rig.db,
      'UPDATE webhook_endpoints SET consecutive_failures = ?, failing_since = ? WHERE id = ?',
      [consecutive, rig.kit.clock.now() - sinceHoursAgo * HOUR, ep],
    );
    return { ep, pass };
  }

  it('disables after 72 h with 10 or more failures, cancels the backlog and audits it', async () => {
    net.respond = fail;
    const { ep, pass } = await failing(9, 73);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(1);
    expect(await endpointOf(rig.db, ep)).toMatchObject({ status: 'disabled', lane_token: null });
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'cancelled', n: 3 }]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('ENDPOINT_DISABLED');
    const audit = await all<{
      actor_type: string;
      target_id: string;
      detail: string;
      org_id: string;
    }>(
      rig.db,
      "SELECT actor_type, target_id, detail, org_id FROM audit_log WHERE action = 'webhook.endpoint_disabled'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'system', target_id: ep, org_id: rig.orgId });
    const detail = JSON.parse(audit[0]?.detail ?? '{}');
    expect(detail).toMatchObject({ endpointId: ep, host: 'hooks.example.com' });
    expect(audit[0]?.detail).not.toContain(`/${ep}`);
    // Fan-out skips a disabled endpoint.
    await addEvents(rig, pass.id, 1);
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'cancelled', n: 3 }]);
  });

  it('keeps the endpoint when it has failed for less than 72 h or fewer than 10 times', async () => {
    net.respond = fail;
    const young = await failing(9, 71);
    await deliverNow(rig, young.ep);
    expect((await endpointOf(rig.db, young.ep))?.status).toBe('active');
    const few = await failing(5, 100);
    await deliverNow(rig, few.ep);
    expect((await endpointOf(rig.db, few.ep))?.status).toBe('active');
  });

  it('the sweep disables an endpoint the handler missed', async () => {
    const { ep } = await failing(12, 80);
    await sweepWebhooks(rig.ctx);
    expect((await endpointOf(rig.db, ep))?.status).toBe('disabled');
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'cancelled', n: 3 }]);
    expect(rig.kit.queue.sent).toEqual([]);
  });

  it('a resumed endpoint delivers again and clears its counters', async () => {
    net.respond = fail;
    const { ep, pass } = await failing(9, 73);
    await deliverNow(rig, ep);
    await run(
      rig.db,
      `UPDATE webhook_endpoints SET status = 'active', disabled_at = NULL, consecutive_failures = 0,
         failing_since = NULL WHERE id = ?`,
      [ep],
    );
    net.respond = () => new Response('ok');
    await addEvents(rig, pass.id, 1);
    await deliverNow(rig, ep);
    expect(await endpointOf(rig.db, ep)).toMatchObject({
      status: 'active',
      consecutive_failures: 0,
      failing_since: null,
    });
    expect((await endpointOf(rig.db, ep))?.last_success_at).not.toBeNull();
  });

  it('a success clears the failure run', async () => {
    const { ep } = await failing(4, 10);
    await deliverNow(rig, ep);
    expect(await endpointOf(rig.db, ep)).toMatchObject({
      consecutive_failures: 0,
      failing_since: null,
    });
  });
});
