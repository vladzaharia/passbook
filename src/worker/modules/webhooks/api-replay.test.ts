import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { type Api, auditOf, BASE, rowCount, setupApi, wipe } from './api-test-fixtures.ts';
import { deliveryOf, drain, type Net, statesOf, stubNet } from './deliver-test-fixtures.ts';
import { clearResolverMemo } from './resolver-memo.ts';

let api: Api;
let net: Net;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
});
afterAll(() => net.restore());
beforeEach(async () => {
  await wipe(api.rig);
  net.calls.length = 0;
  net.respond = () => new Response('ok', { status: 200 });
  clearResolverMemo();
  api.resetLimits();
  api.rig.hooks.sent.length = 0;
});

const MIN = 60_000;

/** A fresh org with an admin and one endpoint on pass.issued, so tests never see each other's events. */
async function scene(url = 'https://hooks.example.com/r/abcd') {
  const orgId = await api.otherOrg();
  const admin = await api.member(['org_admin'], { orgId });
  const made = (await api.call('POST', BASE, { orgId, url, eventTypes: ['pass.issued'] }, admin))
    .json as { endpoint: { id: string } };
  const endpointId = made.endpoint.id;
  const passes = async (n: number, gapMs = MIN) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await api.rig.kit.pass({ orgId }));
      api.rig.kit.clock.advance(gapMs);
    }
    return out;
  };
  const seqs = async (id = endpointId) =>
    (
      await all<{ event_seq: number }>(
        api.rig.db,
        'SELECT event_seq FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY event_seq',
        [id],
      )
    ).map((r) => r.event_seq);
  /** Stage a final state, as if the engine had given up (or succeeded). */
  const finish = (state: 'failed' | 'cancelled' | 'delivered', where = '1 = 1', id = endpointId) =>
    run(
      api.rig.db,
      `UPDATE webhook_deliveries SET state = ?, finished_at = 1, attempts = 9, replays = 0
       WHERE endpoint_id = ? AND ${where}`,
      [state, id],
    );
  return { orgId, admin, endpointId, passes, seqs, finish, base: `${BASE}/${endpointId}` };
}

describe('deliveries', () => {
  it('lists newest first with a cursor, filters by state and type, and reads one with its payload', async () => {
    const s = await scene();
    await s.passes(3);
    const seqs = await s.seqs();
    expect(seqs).toHaveLength(3);
    await s.finish('failed', `event_seq = ${seqs[0]}`);
    const p1 = await api.call('GET', `${s.base}/deliveries?limit=2`, undefined, s.admin);
    expect(p1.json.items).toHaveLength(2);
    expect(p1.json.items[0]).toMatchObject({
      type: 'pass.issued',
      state: 'pending',
      attempts: 0,
      replays: 0,
    });
    // Opaque and per tenant: not the platform-wide sequence.
    expect(p1.json.nextCursor).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p1.json.nextCursor).not.toBe(String(seqs[1]));
    const p2 = await api.call(
      'GET',
      `${s.base}/deliveries?limit=2&cursor=${p1.json.nextCursor}`,
      undefined,
      s.admin,
    );
    expect(p2.json.items).toHaveLength(1);
    expect(p2.json.items[0].state).toBe('failed');
    expect(p2.json.nextCursor).toBeNull();
    const failed = await api.call('GET', `${s.base}/deliveries?state=failed`, undefined, s.admin);
    expect(failed.json.items).toHaveLength(1);
    expect(
      (await api.call('GET', `${s.base}/deliveries?type=pass.voided`, undefined, s.admin)).json
        .items,
    ).toEqual([]);
    expect(
      (await api.call('GET', `${s.base}/deliveries?cursor=abc`, undefined, s.admin)).status,
    ).toBe(422);
    const eventId = failed.json.items[0].eventId as string;
    const one = await api.call('GET', `${s.base}/deliveries/${eventId}`, undefined, s.admin);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ eventId, state: 'failed', attemptLog: [] });
    expect(one.json.payload).toMatchObject({
      id: eventId,
      type: 'pass.issued',
      orgId: s.orgId,
      mode: 'live',
      apiVersion: '2026-12-01',
    });
    expect((await api.call('GET', `${s.base}/deliveries/nope`, undefined, s.admin)).status).toBe(
      404,
    );
  });

  it('shows the attempts of a delivery the engine sent', async () => {
    const s = await scene();
    await s.passes(1);
    await api.call('POST', `${s.base}/test`, undefined, s.admin);
    // The kick of the POST above queued the lane; run it.
    await drain(api.rig);
    const [item] = (await api.call('GET', `${s.base}/deliveries`, undefined, s.admin)).json.items;
    expect(item).toMatchObject({ state: 'delivered', attempts: 1, lastStatus: 200 });
    const one = await api.call('GET', `${s.base}/deliveries/${item.eventId}`, undefined, s.admin);
    expect(one.json.attemptLog).toEqual([
      expect.objectContaining({ attempt: 1, trigger: 'event', status: 200 }),
    ]);
  });

  it('is a 404 for another organization and for an event of another endpoint', async () => {
    const a = await scene();
    const b = await scene('https://hooks.example.com/other');
    await a.passes(1);
    await b.passes(1);
    const bEvent = (await api.call('GET', `${b.base}/deliveries`, undefined, b.admin)).json.items[0]
      .eventId;
    expect((await api.call('GET', `${a.base}/deliveries`, undefined, b.admin)).status).toBe(404);
    expect(
      (await api.call('GET', `${a.base}/deliveries/${bEvent}`, undefined, a.admin)).status,
    ).toBe(404);
    expect(
      (await api.call('POST', `${a.base}/deliveries/${bEvent}/replay`, undefined, a.admin)).status,
    ).toBe(404);
  });
});

describe('replay of one delivery', () => {
  it('resets it, sends the same event id and body again, and audits the host', async () => {
    const s = await scene();
    await s.passes(1);
    const [seq] = await s.seqs();
    await s.finish('failed');
    const eventId = (await api.call('GET', `${s.base}/deliveries`, undefined, s.admin)).json
      .items[0].eventId;
    const replayed = await api.call(
      'POST',
      `${s.base}/deliveries/${eventId}/replay`,
      undefined,
      s.admin,
    );
    expect(replayed.json).toEqual({ queued: 1 });
    expect(await deliveryOf(api.rig.db, s.endpointId, seq)).toMatchObject({
      state: 'pending',
      attempts: 0,
      next_at: 0,
      finished_at: null,
    });
    expect(
      await first(api.rig.db, 'SELECT replays FROM webhook_deliveries WHERE endpoint_id = ?', [
        s.endpointId,
      ]),
    ).toEqual({ replays: 1 });
    // The kick after the POST claimed the lane; running it posts the same event.
    await drain(api.rig);
    expect(net.calls).toHaveLength(1);
    expect(JSON.parse(net.calls[0]?.body ?? '{}').id).toBe(eventId);
    expect(net.calls[0]?.headers['x-passbook-event-id']).toBe(eventId);
    const attempts = await all<{ trigger: string }>(
      api.rig.db,
      'SELECT trigger FROM webhook_attempts WHERE endpoint_id = ?',
      [s.endpointId],
    );
    expect(attempts).toEqual([{ trigger: 'replay' }]);
    const [audit] = await auditOf(api.rig.db, 'webhook.replay');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      host: 'hooks.example.com',
      eventId,
      count: 1,
    });
    expect(audit?.detail).not.toContain('abcd');
  });

  it('refuses a delivery that is still pending, and a reader', async () => {
    const s = await scene();
    await s.passes(1);
    const eventId = (await api.call('GET', `${s.base}/deliveries`, undefined, s.admin)).json
      .items[0].eventId;
    await expectProblem(
      await api.call('POST', `${s.base}/deliveries/${eventId}/replay`, undefined, s.admin),
      409,
      'DELIVERY_PENDING',
    );
    await s.finish('delivered');
    const reader = await api.member(['read_only'], { orgId: s.orgId });
    expect(
      (await api.call('POST', `${s.base}/deliveries/${eventId}/replay`, undefined, reader)).status,
    ).toBe(403);
    expect(
      (await api.call('POST', `${s.base}/deliveries/${eventId}/replay`, undefined, s.admin)).json,
    ).toEqual({ queued: 1 });
  });
});

describe('bulk replay', () => {
  it('resets the chosen states inside the event-time window only', async () => {
    const s = await scene();
    const t0 = api.rig.kit.clock.now();
    await s.passes(4);
    await s.finish('failed');
    const seqs = await s.seqs();
    await s.finish('cancelled', `event_seq = ${seqs[1]}`);
    await s.finish('delivered', `event_seq = ${seqs[2]}`);
    const window = { from: t0 + MIN, to: t0 + 2 * MIN };
    // Events 2 and 3 are inside; 2 is cancelled, 3 delivered. Only failed asked: nothing inside.
    expect(
      (await api.call('POST', `${s.base}/replay`, { ...window, include: 'failed' }, s.admin)).json,
    ).toEqual({ queued: 0 });
    api.resetLimits();
    expect(
      (
        await api.call(
          'POST',
          `${s.base}/replay`,
          { ...window, include: 'failed_and_cancelled' },
          s.admin,
        )
      ).json,
    ).toEqual({ queued: 1 });
    // A committed replay spends the minute (counted from its audit row).
    api.rig.kit.clock.advance(MIN + 1);
    expect(
      (await api.call('POST', `${s.base}/replay`, { ...window, include: 'all' }, s.admin)).json,
    ).toEqual({ queued: 1 });
    expect(await statesOf(api.rig.db, s.endpointId)).toEqual([
      { state: 'failed', n: 2 },
      { state: 'pending', n: 2 },
    ]);
    const reset = await all<{ event_seq: number; replays: number; attempts: number }>(
      api.rig.db,
      "SELECT event_seq, replays, attempts FROM webhook_deliveries WHERE endpoint_id = ? AND state = 'pending' ORDER BY event_seq",
      [s.endpointId],
    );
    expect(reset).toEqual([
      { event_seq: seqs[1], replays: 1, attempts: 0 },
      { event_seq: seqs[2], replays: 1, attempts: 0 },
    ]);
    expect(await auditOf(api.rig.db, 'webhook.replay')).toHaveLength(2);
  });

  it('never touches another endpoint or organization', async () => {
    const a = await scene();
    const b = await scene('https://hooks.example.com/b');
    await a.passes(2);
    await b.passes(2);
    await a.finish('failed');
    await b.finish('failed');
    const res = await api.call(
      'POST',
      `${a.base}/replay`,
      { from: 0, to: 4e12, include: 'all' },
      a.admin,
    );
    expect(res.json).toEqual({ queued: 2 });
    expect(await statesOf(api.rig.db, b.endpointId)).toEqual([{ state: 'failed', n: 2 }]);
    expect(
      (await api.call('POST', `${b.base}/replay`, { from: 0, to: 4e12 }, a.admin)).status,
    ).toBe(404);
  });

  it('allows one a minute per endpoint, and validates the window', async () => {
    const s = await scene();
    const b = await scene('https://hooks.example.com/b');
    await s.passes(1);
    await s.finish('failed');
    expect(
      (await api.call('POST', `${s.base}/replay`, { from: 0, to: 4e12 }, s.admin)).json,
    ).toEqual({ queued: 1 });
    await s.finish('failed');
    expect(
      (await api.call('POST', `${s.base}/replay`, { from: 0, to: 4e12 }, s.admin)).status,
    ).toBe(429);
    expect(await statesOf(api.rig.db, s.endpointId)).toEqual([{ state: 'failed', n: 1 }]);
    expect(
      (await api.call('POST', `${b.base}/replay`, { from: 0, to: 4e12 }, b.admin)).status,
    ).toBe(200);
    for (const body of [{ from: 5, to: 1 }, { from: 0 }, { from: 0, to: 1, include: 'some' }])
      expect(
        (await api.call('POST', `${s.base}/replay`, body, s.admin)).status,
        JSON.stringify(body),
      ).toBe(422);
  });

  it('with missing, adds deliveries for subscribed events the endpoint never had', async () => {
    const orgId = await api.otherOrg();
    const admin = await api.member(['org_admin'], { orgId });
    const [pass] = [await api.rig.kit.pass({ orgId }), await api.rig.kit.pass({ orgId })];
    const voided = await api.rig.kit.pass({ orgId });
    await run(api.rig.db, 'UPDATE passes SET status = ? WHERE id = ?', ['voided', voided.id]);
    await api.rig.kit.pass({ orgId, mode: 'test' });
    const made = (
      await api.call(
        'POST',
        BASE,
        { orgId, url: 'https://hooks.example.com/m', eventTypes: ['pass.issued'] },
        admin,
      )
    ).json;
    const id = made.endpoint.id as string;
    expect(await rowCount(api.rig.db, 'webhook_deliveries', 'endpoint_id = ?', [id])).toBe(0);
    const plain = await api.call(
      'POST',
      `${BASE}/${id}/replay`,
      { from: 0, to: 4e12, include: 'all' },
      admin,
    );
    expect(plain.json).toEqual({ queued: 0 });
    api.resetLimits();
    const res = await api.call(
      'POST',
      `${BASE}/${id}/replay`,
      { from: 0, to: 4e12, missing: true },
      admin,
    );
    // Three live passes issued in this org; the test-mode pass is another mode.
    expect(res.json).toEqual({ queued: 3 });
    expect(await statesOf(api.rig.db, id)).toEqual([{ state: 'pending', n: 3 }]);
    expect(pass).toBeDefined();
    // A second run adds nothing: they exist now, and pending ones are not reset.
    api.rig.kit.clock.advance(MIN + 1);
    expect(
      (await api.call('POST', `${BASE}/${id}/replay`, { from: 0, to: 4e12, missing: true }, admin))
        .json,
    ).toEqual({ queued: 0 });
    const rows = await all<{ org_id: string; mode: string }>(
      api.rig.db,
      'SELECT org_id, mode FROM webhook_deliveries WHERE endpoint_id = ?',
      [id],
    );
    expect(rows.every((r) => r.org_id === orgId && r.mode === 'live')).toBe(true);
  });

  it('with missing, respects the type and template filters and the window', async () => {
    const orgId = await api.otherOrg();
    const admin = await api.member(['org_admin'], { orgId });
    const t0 = api.rig.kit.clock.now();
    await api.rig.kit.pass({ orgId });
    api.rig.kit.clock.advance(10 * MIN);
    await api.rig.kit.pass({ orgId });
    const made = (
      await api.call(
        'POST',
        BASE,
        { orgId, url: 'https://hooks.example.com/w', eventTypes: ['pass.voided'] },
        admin,
      )
    ).json;
    const none = await api.call(
      'POST',
      `${BASE}/${made.endpoint.id}/replay`,
      { from: 0, to: 4e12, missing: true },
      admin,
    );
    expect(none.json).toEqual({ queued: 0 });
    api.resetLimits();
    const made2 = (
      await api.call(
        'POST',
        BASE,
        { orgId, url: 'https://hooks.example.com/w2', eventTypes: ['pass.issued'] },
        admin,
      )
    ).json;
    const win = await api.call(
      'POST',
      `${BASE}/${made2.endpoint.id}/replay`,
      { from: t0, to: t0 + MIN, missing: true },
      admin,
    );
    expect(win.json).toEqual({ queued: 1 });
  });
});
