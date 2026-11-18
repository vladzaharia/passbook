import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { assertPublicHost, createSafeFetch, dohResolver } from '../../platform/safe-fetch.ts';
import { attemptDelivery } from './deliver.ts';
import {
  addEvents,
  deliverNow,
  deliveryOf,
  endpointWithSecret,
  type Net,
  type Rig,
  reset,
  setupRig,
  stubNet,
} from './deliver-test-kit.ts';
import { nextDue } from './repo-delivery-state.ts';
import { getEndpoint } from './repo-endpoints.ts';

import { ALL_TYPES } from './webhooks-test-fixtures.ts';

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

async function to(url: string) {
  const ep = await endpointWithSecret(rig, { orgId: rig.orgId, url, eventTypes: ALL_TYPES });
  const pass = await rig.kit.pass();
  return { ep, pass };
}

describe('what the sender does with an answer', () => {
  it('a redirect is REDIRECT_BLOCKED and is retried', async () => {
    net.respond = () =>
      new Response('', { status: 302, headers: { location: 'https://evil.test/' } });
    const { ep } = await to('https://hooks.example.com/a');
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(1);
    expect(await deliveryOf(rig.db, ep)).toMatchObject({
      state: 'pending',
      last_status: null,
      last_error: 'REDIRECT_BLOCKED',
    });
  });

  it('a platform host is refused before any request', async () => {
    const host = new URL(rig.kit.env.PUBLIC_BASE_URL).hostname;
    const { ep } = await to(`https://${host}/hook`);
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('UNSAFE_URL');
  });

  it('a private resolution is refused before any request', async () => {
    net.dns['private.example.com'] = ['10.0.0.5'];
    const { ep } = await to('https://private.example.com/hook');
    await deliverNow(rig, ep);
    expect(net.calls).toEqual([]);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('UNSAFE_URL');
  });

  it('a slow receiver is TIMEOUT', async () => {
    net.respond = () => new Promise<Response>(() => undefined);
    const { ep } = await to('https://hooks.example.com/slow');
    await deliverNow(rig, ep, 50);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('TIMEOUT');
  });

  it('a connection error is UPSTREAM', async () => {
    net.respond = () => {
      throw new TypeError('connection reset');
    };
    const { ep } = await to('https://hooks.example.com/down');
    await deliverNow(rig, ep);
    expect((await deliveryOf(rig.db, ep))?.last_error).toBe('UPSTREAM');
  });
});

describe('DNS rebinding between save and send', () => {
  it('refuses a host that resolved public at save and private at send', async () => {
    const host = 'rebind.example.com';
    // Save time: a public answer passes the check.
    await expect(assertPublicHost(host, dohResolver())).resolves.toBeUndefined();
    const { ep, pass } = await to(`https://${host}/hook`);
    await deliverNow(rig, ep);
    expect(await deliveryOf(rig.db, ep)).toMatchObject({ state: 'delivered' });
    expect(net.calls).toHaveLength(1);

    // The host now answers with a private address; the memo (60 s) has not expired yet.
    net.dns[host] = ['169.254.169.254'];
    await addEvents(rig, pass.id, 1);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(2);
    // After the memo expires the next send resolves again and is refused.
    rig.kit.clock.advance(61_000);
    await addEvents(rig, pass.id, 1);
    await deliverNow(rig, ep);
    expect(net.calls).toHaveLength(2);
    const rows = await rig.db
      .prepare('SELECT last_error FROM webhook_deliveries WHERE endpoint_id = ? AND state = ?')
      .bind(ep, 'pending')
      .all<{ last_error: string }>();
    expect(rows.results.map((r) => r.last_error)).toContain('UNSAFE_URL');
  });

  it('the sender re-checks even when the save-time check passed (safe-fetch is not bypassed)', async () => {
    net.dns['later.example.com'] = ['93.184.216.34'];
    const resolver = dohResolver();
    const send = createSafeFetch({ resolver, timeoutMs: 1000 });
    await expect(send('https://later.example.com/x', { method: 'POST' })).resolves.toBeDefined();
    net.dns['later.example.com'] = ['10.1.2.3'];
    await expect(send('https://later.example.com/x', { method: 'POST' })).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
  });
});

describe('tenant assertion at send (proof 6)', () => {
  it('cancels a feed row of another org or mode, unsent', async () => {
    const { ep } = await to('https://hooks.example.com/t');
    const endpoint = await getEndpoint(rig.db, { orgId: rig.orgId, mode: 'live' }, ep);
    const lane = { endpointId: ep, orgId: rig.orgId, mode: 'live' as const };
    for (const bad of [{ orgId: 'other-org' }, { mode: 'test' as const }]) {
      const due = await nextDue(rig.db, lane, rig.kit.clock.now());
      if (!endpoint || !due) throw new Error('setup');
      const sender = {
        send: createSafeFetch({ timeoutMs: 100 }),
        ring: () => Promise.reject(new Error('no secret may be read')),
      };
      const out = await attemptDelivery(rig.ctx, sender, endpoint, {
        ...due,
        feed: { ...due.feed, ...bad },
      });
      expect(out).toBe('cancelled');
      expect(net.calls).toEqual([]);
      expect(await deliveryOf(rig.db, ep)).toMatchObject({
        state: 'cancelled',
        last_error: 'WEBHOOK_TENANT_MISMATCH',
        attempts: 0,
      });
      // Re-arm the row for the next variant.
      await run(
        rig.db,
        "UPDATE webhook_deliveries SET state = 'pending', finished_at = NULL, last_error = NULL WHERE endpoint_id = ?",
        [ep],
      );
    }
  });
});
