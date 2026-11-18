import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { all } from '../../platform/db.ts';
import { type Api, auditOf, BASE, rowCount, setupApi, wipe } from './api-test-fixtures.ts';
import { drain, type Net, statesOf, stubNet } from './deliver-test-fixtures.ts';
import { dispatchLane } from './dispatch.ts';
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

async function org(url = 'https://hooks.example.com/x') {
  const orgId = await api.otherOrg();
  const admin = await api.member(['org_admin'], { orgId });
  const create = async (u = url) =>
    (await api.call('POST', BASE, { orgId, url: u, eventTypes: ['pass.issued'] }, admin)).json
      .endpoint?.id as string;
  return { orgId, admin, create };
}

describe('test sends', () => {
  it('charge the destination host: a spent host budget stops them', async () => {
    const o = await org();
    const a = await o.create('https://shared.example.com/a');
    const b = await o.create('https://shared.example.com/b');
    Object.assign(api.rig.kit.env, { RL_WEBHOOK_HOST: fakeRateLimiter({ limit: 1 }) });
    expect((await api.call('POST', `${BASE}/${a}/test`, undefined, o.admin)).status).toBe(200);
    expect((await api.call('POST', `${BASE}/${b}/test`, undefined, o.admin)).status).toBe(429);
    expect(net.calls).toHaveLength(1);
  });
});

describe('test sends and the org share', () => {
  it('spend the org share of the host before the global budget', async () => {
    const o = await org();
    const a = await o.create('https://shared.example.com/a');
    const host = fakeRateLimiter({ limit: 100 });
    Object.assign(api.rig.kit.env, {
      RL_WEBHOOK_HOST_ORG: fakeRateLimiter({ limit: 1 }),
      RL_WEBHOOK_HOST: host,
    });
    expect((await api.call('POST', `${BASE}/${a}/test`, undefined, o.admin)).status).toBe(200);
    expect((await api.call('POST', `${BASE}/${a}/test`, undefined, o.admin)).status).toBe(429);
    // The refused one never reached the global key.
    expect([...host.counts.values()]).toEqual([1]);
  });
});

describe('creates', () => {
  it('stop at 20 an hour per org, and deleting does not reset the count', async () => {
    const o = await org();
    for (let i = 0; i < 20; i++) {
      const id = await o.create(`https://hooks.example.com/${i}`);
      expect(id, `create ${i}`).toBeTruthy();
      await api.call('DELETE', `${BASE}/${id}`, undefined, o.admin);
    }
    const res = await api.call(
      'POST',
      BASE,
      { orgId: o.orgId, url: 'https://hooks.example.com/z', eventTypes: ['pass.issued'] },
      o.admin,
    );
    expect(res.status).toBe(429);
    expect(await rowCount(api.rig.db, 'webhook_endpoints', 'org_id = ?', [o.orgId])).toBe(0);
    // Another org is unaffected.
    expect(await (await org()).create()).toBeTruthy();
  });
});

describe('replay limits', () => {
  it('bulk replay is one a minute per tenant, across its endpoints', async () => {
    const o = await org();
    // A pass from before the endpoints: a backfill has something to queue, so the replay commits.
    await api.rig.kit.pass({ orgId: o.orgId });
    const a = await o.create('https://hooks.example.com/a');
    const b = await o.create('https://hooks.example.com/b');
    const body = { from: 0, to: 4e12, missing: true };
    expect((await api.call('POST', `${BASE}/${a}/replay`, body, o.admin)).status).toBe(200);
    expect((await api.call('POST', `${BASE}/${b}/replay`, body, o.admin)).status).toBe(429);
    const other = await org();
    await api.rig.kit.pass({ orgId: other.orgId });
    const c = await other.create();
    expect((await api.call('POST', `${BASE}/${c}/replay`, body, other.admin)).status).toBe(200);
    // A replay that found nothing to queue committed nothing and spent nothing.
    const none = await org();
    const d = await none.create();
    expect(
      (await api.call('POST', `${BASE}/${d}/replay`, { from: 0, to: 4e12 }, none.admin)).status,
    ).toBe(200);
    expect(
      (await api.call('POST', `${BASE}/${d}/replay`, { from: 0, to: 4e12 }, none.admin)).status,
    ).toBe(200);
  });

  it('single replays are limited per tenant and audited once a minute', async () => {
    const o = await org();
    const id = await o.create();
    for (let i = 0; i < 3; i++) await api.rig.kit.pass({ orgId: o.orgId });
    const events = (await api.call('GET', `${BASE}/${id}/deliveries`, undefined, o.admin)).json
      .items as { eventId: string }[];
    await api.rig.db
      .prepare("UPDATE webhook_deliveries SET state='failed', finished_at=1 WHERE endpoint_id = ?")
      .bind(id)
      .run();
    for (const e of events)
      expect(
        (await api.call('POST', `${BASE}/${id}/deliveries/${e.eventId}/replay`, undefined, o.admin))
          .status,
      ).toBe(200);
    expect(await auditOf(api.rig.db, 'webhook.replay')).toHaveLength(1);
    api.rig.kit.clock.advance(2 * MIN);
    await api.rig.db
      .prepare("UPDATE webhook_deliveries SET state='failed', finished_at=1 WHERE endpoint_id = ?")
      .bind(id)
      .run();
    const admin = await api.member(['org_admin'], { orgId: o.orgId });
    expect(
      (
        await api.call(
          'POST',
          `${BASE}/${id}/deliveries/${events[0]?.eventId}/replay`,
          undefined,
          admin,
        )
      ).status,
    ).toBe(200);
    expect(await auditOf(api.rig.db, 'webhook.replay')).toHaveLength(2);
  });

  it('a storm of one tenant cannot use up the host for another', async () => {
    const A = await org();
    const B = await org();
    const host = 'https://shared.example.com';
    const a = await A.create(`${host}/a`);
    const b = await B.create(`${host}/b`);
    for (let i = 0; i < 6; i++) await api.rig.kit.pass({ orgId: A.orgId });
    await api.rig.kit.pass({ orgId: B.orgId });
    // The host allows 4 a minute overall and each org 3.
    Object.assign(api.rig.kit.env, {
      RL_WEBHOOK_HOST: fakeRateLimiter({ limit: 4 }),
      RL_WEBHOOK_HOST_ORG: fakeRateLimiter({ limit: 3 }),
    });
    await dispatchLane(api.rig.ctx, { endpointId: a, orgId: A.orgId, mode: 'live' });
    await drain(api.rig);
    expect(net.calls).toHaveLength(3);
    await dispatchLane(api.rig.ctx, { endpointId: b, orgId: B.orgId, mode: 'live' });
    await drain(api.rig);
    expect(net.calls).toHaveLength(4);
    expect(await statesOf(api.rig.db, b)).toEqual([{ state: 'delivered', n: 1 }]);
    expect((await statesOf(api.rig.db, a)).find((r) => r.state === 'delivered')?.n).toBe(3);
  });
});

describe('cursors', () => {
  it('are not the platform sequence and differ per org', async () => {
    const A = await org();
    const B = await org();
    const key = async (o: typeof A) => await api.key({ scopes: ['passes:read'], orgId: o.orgId });
    const pa = await api.rig.kit.pass({ orgId: A.orgId });
    await api.rig.kit.pass({ orgId: B.orgId });
    const ra = await api.call('GET', '/api/v1/events', undefined, await key(A));
    const rb = await api.call('GET', '/api/v1/events', undefined, await key(B));
    const seqs = await all<{ seq: number; org_id: string }>(
      api.rig.db,
      'SELECT seq, org_id FROM event_feed WHERE pass_id = ?',
      [pa.id],
    );
    const seqA = seqs[0]?.seq ?? 0;
    expect(ra.json.nextCursor).not.toContain(String(seqA));
    expect(ra.json.nextCursor).toMatch(/^ev2\.[A-Za-z0-9_-]{22}$/);
    expect(ra.json.nextCursor).not.toBe(rb.json.nextCursor);
    // Round trip: the cursor of the last item leaves nothing after it.
    const next = await api.call(
      'GET',
      `/api/v1/events?after=${ra.json.nextCursor}`,
      undefined,
      await key(A),
    );
    expect(next.json.items).toEqual([]);
  });
});

describe('audit', () => {
  it('records the old host when a PATCH moves the URL', async () => {
    const o = await org();
    const id = await o.create('https://old.example.com/p');
    await api.call('PATCH', `${BASE}/${id}`, { url: 'https://new.example.com/p' }, o.admin);
    const [row] = await auditOf(api.rig.db, 'webhook.endpoint.update');
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({
      host: 'new.example.com',
      previousHost: 'old.example.com',
    });
  });
});
