import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import {
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  setupRig,
  stubNet,
} from './deliver-test-kit.ts';
import { kick } from './kick.ts';

let rig: Rig;
let net: Net;

beforeAll(async () => {
  rig = await setupRig();
});
beforeEach(async () => {
  net = stubNet();
  await reset(rig);
});
afterEach(() => net.restore());

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
    expect(rig.kit.queue.sent).toHaveLength(1);
    expect(rig.kit.queue.sent[0]).toMatchObject({ kind: 'webhook.deliver' });
  });

  it('does nothing after a read', async () => {
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    await request('GET', '/health');
    expect(rig.kit.queue.sent).toEqual([]);
  });

  it('is a no-op when no endpoint exists, and trusts that answer for 30 s', async () => {
    await kick(rig.ctx);
    expect(rig.kit.queue.sent).toEqual([]);
    // An endpoint appears with work due, but the isolate's memo still says "none".
    await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    await kick(rig.ctx);
    expect(rig.kit.queue.sent).toEqual([]);
    rig.kit.clock.advance(31_000);
    await kick(rig.ctx);
    expect(rig.kit.queue.sent).toHaveLength(1);
  });

  it('never throws when the queue is down; the lane is released for the sweep', async () => {
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId });
    await rig.kit.pass();
    rig.kit.queue.fail = true;
    try {
      await expect(kick(rig.ctx)).resolves.toBeUndefined();
    } finally {
      rig.kit.queue.fail = false;
    }
    const row = await rig.db
      .prepare('SELECT lane_token FROM webhook_endpoints WHERE id = ?')
      .bind(ep)
      .first<{ lane_token: string | null }>();
    expect(row?.lane_token).toBeNull();
  });
});
