import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.ts';
import {
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  setupRig,
  stubNet,
} from './deliver-test-fixtures.ts';
import { kick, kickAfterWrite, noteActiveEndpoint } from './kick.ts';

let rig: Rig;
let net: Net;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => {
  net.restore();
  vi.restoreAllMocks();
});

/** A request through the real app, with the background work it started awaited. */
async function request(method: string, path: string) {
  const app = createApp({ clock: rig.kit.clock });
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request(
    `https://wallet.test${path}`,
    {
      method,
      ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
    },
    rig.kit.env,
    executionCtx,
  );
  await Promise.all(pending);
  return res;
}

describe('the kick', () => {
  it('claims a due lane after a write request, even one that fails', async () => {
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    const res = await request('POST', '/api/v1/scan/pair');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rig.hooks.sent).toHaveLength(1);
    expect(rig.hooks.sent[0]).toMatchObject({ kind: 'webhook.deliver' });
  });

  it('does nothing after a read', async () => {
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    await request('GET', '/health');
    expect(rig.hooks.sent).toEqual([]);
  });

  it('is a no-op when no endpoint exists, and trusts that answer for 30 s', async () => {
    await kick(rig.ctx);
    expect(rig.hooks.sent).toEqual([]);
    rig.kit.clock.advance(2_000);
    // An endpoint appears with work due, but the isolate's memo still says "none".
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    await kick(rig.ctx);
    expect(rig.hooks.sent).toEqual([]);
    rig.kit.clock.advance(31_000);
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
  });

  it('trusts "none" for 30 s unless an endpoint was just made in this isolate', async () => {
    await kick(rig.ctx);
    rig.kit.clock.advance(2_000);
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    noteActiveEndpoint(rig.ctx);
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
  });

  it('a write inside the one-second window of the last kick still gets its own kick, once', async () => {
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    await kick(rig.ctx);
    expect(rig.hooks.sent).toHaveLength(1);
    // New work and a free lane, half a second later: the plain kick is throttled, the write's kick waits and runs.
    await rig.db
      .prepare('UPDATE webhook_endpoints SET lane_token = NULL, lane_until = NULL WHERE id = ?')
      .bind(ep)
      .run();
    rig.kit.clock.advance(500);
    // The wait is the clock's sleep: here it moves the test clock on and returns at once.
    const sleeps: number[] = [];
    vi.spyOn(rig.kit.clock, 'sleep').mockImplementation(async (ms) => {
      sleeps.push(ms);
      rig.kit.clock.advance(ms);
    });
    await Promise.all([kickAfterWrite(rig.ctx), kickAfterWrite(rig.ctx)]);
    expect(rig.hooks.sent).toHaveLength(2);
    // Once, for the rest of the window, though two writes asked.
    expect(sleeps).toEqual([525]);
  });

  it('never throws when the queue is down; the lane is released for the sweep', async () => {
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    rig.hooks.fail = true;
    try {
      await expect(kick(rig.ctx)).resolves.toBeUndefined();
    } finally {
      rig.hooks.fail = false;
    }
    const row = await rig.db
      .prepare('SELECT lane_token FROM webhook_endpoints WHERE id = ?')
      .bind(ep)
      .first<{ lane_token: string | null }>();
    expect(row?.lane_token).toBeNull();
  });
});
