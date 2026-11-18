import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifySignedRequest } from '../../connectors/lib/hmac.ts';
import { all } from '../../platform/db.ts';
import {
  deliverNow,
  deliveryOf,
  endpointOf,
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  seedSecret,
  setupRig,
  stubNet,
} from './deliver-test-fixtures.ts';
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

/** An endpoint and a pass created after it, so the trigger fans the pass.issued event out. */
async function one(types = ALL_TYPES) {
  const ep = await endpointWithSecret(rig, { orgId: rig.orgId, eventTypes: types });
  const pass = await rig.kit.pass();
  return { ep, pass };
}

describe('a successful delivery', () => {
  it('posts the signed event once and records it', async () => {
    const { ep, pass } = await one();
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(1);
    const call = net.calls[0];
    const event = JSON.parse(call?.body ?? '{}');
    expect(event).toMatchObject({
      type: 'pass.issued',
      orgId: rig.orgId,
      mode: 'live',
      pass: { id: pass.id },
    });
    expect(call?.headers['x-passbook-event-id']).toBe(event.id);
    const req = new Request('https://x.test/', {
      method: 'POST',
      body: call?.body ?? '',
      headers: {
        'x-wallet-signature': call?.headers['x-passbook-signature'] ?? '',
        'x-wallet-timestamp': call?.headers['x-passbook-timestamp'] ?? '',
      },
    });
    await expect(
      verifySignedRequest(req, { secret: 'whsec_test', now: rig.kit.clock.now() }),
    ).resolves.toBeDefined();
    expect(await deliveryOf(rig.db, ep)).toMatchObject({
      state: 'delivered',
      attempts: 1,
      last_status: 200,
    });
    expect(await endpointOf(rig.db, ep)).toMatchObject({
      consecutive_failures: 0,
      lane_token: null,
    });
    const attempts = await all<{ trigger: string; status: number }>(
      rig.db,
      'SELECT trigger, status FROM webhook_attempts WHERE endpoint_id = ?',
      [ep],
    );
    expect(attempts).toEqual([{ trigger: 'event', status: 200 }]);
  });

  it('signs with both secrets during a rotation overlap', async () => {
    const ep = await endpointWithSecret(rig, { orgId: rig.orgId, secret: 'whsec_new' });
    await seedSecret(rig, {
      endpointId: ep,
      value: 'whsec_old',
      expiresAt: rig.kit.clock.now() + HOUR,
    });
    await rig.kit.pass();
    await deliverNow(rig, ep);
    const values = (net.calls[0]?.headers['x-passbook-signature'] ?? '').split(', ');
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(2);
  });

  it('counts a large 200 body as delivered', async () => {
    net.respond = () => new Response('x'.repeat(3_000_000), { status: 200 });
    const { ep } = await one();
    await deliverNow(rig, ep);
    expect(await deliveryOf(rig.db, ep)).toMatchObject({ state: 'delivered', last_status: 200 });
  });
});

describe('retries', () => {
  it('re-signs with a fresh timestamp and keeps the event id', async () => {
    net.respond = () => new Response('', { status: 500 });
    const { ep } = await one();
    await deliverNow(rig, ep);
    rig.kit.clock.advance(2 * MIN);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(2);
    const [a, b] = net.calls.map((c) => c.headers);
    expect(a?.['x-passbook-event-id']).toBe(b?.['x-passbook-event-id']);
    expect(a?.['x-passbook-timestamp']).not.toBe(b?.['x-passbook-timestamp']);
    expect(a?.['x-passbook-signature']).not.toBe(b?.['x-passbook-signature']);
  });

  it('follows the schedule with jitter and fails on the ninth attempt, without disabling', async () => {
    net.respond = () => new Response('', { status: 500 });
    const { ep } = await one();
    const base = [1, 5, 30, 120, 360, 720, 1440, 1440].map((m) => m * MIN);
    for (let attempt = 1; attempt <= 9; attempt++) {
      const before = rig.kit.clock.now();
      await deliverNow(rig, ep);
      const d = await deliveryOf(rig.db, ep);
      expect(d?.attempts).toBe(attempt);
      if (attempt < 9) {
        const wait = (d?.next_at ?? 0) - before;
        const step = base[attempt - 1] as number;
        expect(d?.state).toBe('pending');
        expect(wait).toBeGreaterThanOrEqual(step * 0.9 - 1);
        expect(wait).toBeLessThanOrEqual(step * 1.1 + 1);
        rig.kit.clock.set(d?.next_at ?? 0);
      }
    }
    expect(await deliveryOf(rig.db, ep)).toMatchObject({
      state: 'failed',
      attempts: 9,
      last_status: 500,
    });
    expect(net.calls).toHaveLength(9);
    // Nine failures over about 68 h is below the ten-failure bar: still active.
    expect(await endpointOf(rig.db, ep)).toMatchObject({
      status: 'active',
      consecutive_failures: 9,
    });
    const triggers = await all<{ trigger: string }>(
      rig.db,
      'SELECT trigger FROM webhook_attempts WHERE endpoint_id = ? ORDER BY at, attempt',
      [ep],
    );
    expect(triggers.map((t) => t.trigger)).toEqual(['event', ...Array(8).fill('retry')]);
  });

  it('retries a 4xx', async () => {
    net.respond = () => new Response('', { status: 404 });
    const { ep } = await one();
    await deliverNow(rig, ep);
    expect(await deliveryOf(rig.db, ep)).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_status: 404,
    });
  });

  it('honours Retry-After on 429 and 503, capped at 6 h', async () => {
    const { ep } = await one();
    net.respond = () => new Response('', { status: 429, headers: { 'retry-after': '600' } });
    let now = rig.kit.clock.now();
    await deliverNow(rig, ep);
    expect((await deliveryOf(rig.db, ep))?.next_at).toBe(now + 600_000);
    rig.kit.clock.set(now + 600_000);
    now = rig.kit.clock.now();
    net.respond = () => new Response('', { status: 503, headers: { 'retry-after': '999999' } });
    await deliverNow(rig, ep);
    expect((await deliveryOf(rig.db, ep))?.next_at).toBe(now + 6 * HOUR);
    // Other statuses ignore the header.
    rig.kit.clock.set(now + 6 * HOUR);
    now = rig.kit.clock.now();
    net.respond = () => new Response('', { status: 500, headers: { 'retry-after': '99999' } });
    await deliverNow(rig, ep);
    expect(((await deliveryOf(rig.db, ep))?.next_at ?? 0) - now).toBeLessThan(40 * MIN);
  });
});

it('a failed delivery starts the endpoint failure counters', async () => {
  net.respond = () => new Response('', { status: 500 });
  const { ep } = await one();
  await deliverNow(rig, ep);
  const e = await endpointOf(rig.db, ep);
  expect(e?.consecutive_failures).toBe(1);
  expect(e?.failing_since).toBe(rig.kit.clock.now());
});
