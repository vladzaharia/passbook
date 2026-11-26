import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { handleQueue } from '../../jobs/queue.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { finalizeDisabled, runLane } from './deliver.ts';
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
} from './deliver-test-fixtures.ts';
import { dispatchLane } from './dispatch.ts';
import { sweepWebhooks } from './jobs.ts';
import { kick } from './kick.ts';
import { overdueEndpoints } from './repo-delivery-read.ts';
import { ALL_TYPES } from './webhooks-test-fixtures.ts';

let rig: Rig;
let net: Net;
const HOUR = 3_600_000;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => net.restore());

async function backlog(n: number, orgId = rig.orgId) {
  const ep = await endpointWithSecret(rig, { orgId, eventTypes: ALL_TYPES });
  const pass = await rig.kit.pass();
  await addEvents(rig, pass.id, n - 1);
  return { ep, pass };
}

describe('M1: a dead endpoint cannot hold the queue', () => {
  it('opens the circuit after a failure: one probe, the lane closed for the cool-down', async () => {
    net.respond = () => new Response('', { status: 500 });
    const { ep } = await backlog(5);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(1);
    expect((await endpointOf(rig.db, ep))?.lane_token).not.toBeNull();
    expect(await dispatchLane(rig.ctx, laneOf(rig, ep))).toBe(false);
    expect(rig.hooks.sent).toEqual([]);
    rig.kit.clock.advance(31_000);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(2);
  });

  it('stops taking deliveries after 60 s of wall time and hands the rest on', async () => {
    net.respond = () => {
      rig.kit.clock.advance(30_000);
      return new Response('ok');
    };
    const { ep } = await backlog(5);
    await dispatchLane(rig.ctx, laneOf(rig, ep));
    expect(await drain(rig)).toBe(3);
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'delivered', n: 5 }]);
  });

  it('20 endpoints that never answer do not delay a push job', async () => {
    net.respond = () => new Promise<Response>(() => undefined);
    const eps: string[] = [];
    for (const mode of ['live', 'test'] as const)
      for (let i = 0; i < 10; i++)
        eps.push(await endpointWithSecret(rig, { orgId: rig.orgId, mode, eventTypes: ALL_TYPES }));
    await rig.kit.pass();
    await rig.kit.pass({ mode: 'test' });
    await sweepWebhooks(rig.ctx);
    // Lane messages go to the webhook queue and nowhere else.
    expect(rig.hooks.sent).toHaveLength(20);
    expect(rig.kit.queue.sent).toEqual([]);
    const lanes = rig.hooks.sent.splice(0) as Parameters<typeof runLane>[1][];
    let hooksDone = false;
    const hooks = Promise.all(lanes.map((l) => runLane(rig.ctx, l, 600))).then(() => {
      hooksDone = true;
    });
    // A push job on passbook-jobs is consumed while every webhook handler is still stuck.
    let acked = false;
    await handleQueue(
      {
        queue: 'passbook-jobs',
        messages: [
          {
            id: 'm1',
            attempts: 1,
            body: { kind: 'push.deliver', outboxId: 'none' },
            ack: () => {
              acked = true;
            },
            retry: () => undefined,
          },
        ],
      } as unknown as MessageBatch<unknown>,
      rig.kit.env as AppEnv,
      { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
    );
    expect(acked).toBe(true);
    expect(hooksDone).toBe(false);
    await hooks;
  });
});

describe('L1 to L5, I1, I2, I4', () => {
  it('L1: at most one kick per second per isolate', async () => {
    const { ep } = await backlog(2);
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
    await run(
      rig.db,
      'UPDATE webhook_endpoints SET lane_token = NULL, lane_until = NULL WHERE id = ?',
      [ep],
    );
    rig.kit.clock.advance(500);
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
    rig.kit.clock.advance(600);
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(2);
  });

  it('L2: a handler disables only its own endpoint; the sweep does the rest', async () => {
    net.respond = () => new Response('', { status: 500 });
    const a = await backlog(2);
    const b = await endpointWithSecret(rig, { orgId: rig.orgId, eventTypes: ALL_TYPES });
    await addEvents(rig, a.pass.id, 1);
    for (const id of [a.ep, b])
      await run(
        rig.db,
        'UPDATE webhook_endpoints SET consecutive_failures = 12, failing_since = ? WHERE id = ?',
        [rig.kit.clock.now() - 80 * HOUR, id],
      );
    await deliverNow(rig, a.ep);
    expect((await endpointOf(rig.db, a.ep))?.status).toBe('disabled');
    expect((await endpointOf(rig.db, b))?.status).toBe('active');
    await sweepWebhooks(rig.ctx);
    expect((await endpointOf(rig.db, b))?.status).toBe('disabled');
  });

  it('L3: the disable, the cancel and the audit row happen once, together', async () => {
    const { ep } = await backlog(3);
    await run(
      rig.db,
      'UPDATE webhook_endpoints SET consecutive_failures = 12, failing_since = ? WHERE id = ?',
      [rig.kit.clock.now() - 80 * HOUR, ep],
    );
    const overdue = await overdueEndpoints(rig.db, rig.kit.clock.now());
    const [first, second] = await Promise.all([
      finalizeDisabled(rig.ctx, overdue),
      finalizeDisabled(rig.ctx, overdue),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(await statesOf(rig.db, ep)).toEqual([{ state: 'cancelled', n: 3 }]);
    const audit = await all<{ detail: string }>(
      rig.db,
      "SELECT detail FROM audit_log WHERE action = 'webhook.endpoint_disabled' AND target_id = ?",
      [ep],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ host: 'hooks.example.com' });
  });

  it('L5: a per-host limit defers the sends without charging an attempt or the endpoint', async () => {
    Object.assign(rig.kit.env, { RL_WEBHOOK_HOST: fakeRateLimiter({ limit: 2 }) });
    try {
      const { ep } = await backlog(5);
      await deliverNow(rig, ep);
      expect(net.calls).toHaveLength(2);
      const rows = await all<{ attempts: number; last_error: string | null }>(
        rig.db,
        "SELECT attempts, last_error FROM webhook_deliveries WHERE endpoint_id = ? AND state = 'pending'",
        [ep],
      );
      expect(rows.map((r) => r.attempts)).toEqual([0, 0, 0]);
      expect(rows.filter((r) => r.last_error === 'RATE_LIMITED')).toHaveLength(1);
      expect(await endpointOf(rig.db, ep)).toMatchObject({ consecutive_failures: 0 });
    } finally {
      Object.assign(rig.kit.env, { RL_WEBHOOK_HOST: fakeRateLimiter({ limit: 100_000 }) });
    }
  });

  it('I1: a redelivered queue message finds its token swapped and sends nothing', async () => {
    const { ep, pass } = await backlog(2);
    await dispatchLane(rig.ctx, laneOf(rig, ep));
    const msg = rig.hooks.sent[0] as Parameters<typeof runLane>[1];
    await drain(rig);
    expect(net.calls).toHaveLength(2);
    await addEvents(rig, pass.id, 1);
    await runLane(rig.ctx, msg);
    expect(net.calls).toHaveLength(2);
    expect((await deliveryOf(rig.db, ep, 3))?.state ?? 'pending').toBe('pending');
  });

  it('I2: a soft-deleted pass cancels as PASS_GONE', async () => {
    const { ep, pass } = await backlog(1);
    await run(rig.db, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]);
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('PASS_GONE');
  });

  it('I4: the sweep leaves a lane with a queued message alone', async () => {
    const { ep } = await backlog(2);
    await dispatchLane(rig.ctx, laneOf(rig, ep));
    rig.kit.clock.advance(90_000);
    await sweepWebhooks(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
    // A message that never arrives frees the lane after five minutes.
    rig.kit.clock.advance(5 * 60_000);
    await sweepWebhooks(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(2);
  });
});
