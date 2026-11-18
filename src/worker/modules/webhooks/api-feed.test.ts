import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { type Api, BASE, setupApi } from './api-test-fixtures.ts';
import { type Net, stubNet } from './deliver-test-fixtures.ts';

let api: Api;
let net: Net;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
});
afterAll(() => net.restore());

const EVENTS = '/api/v1/events';

/** A fresh org with a passes:read key (org-bound) and n live passes, each with a pass.issued event. */
async function scene(n = 0) {
  const orgId = await api.otherOrg();
  const key = await api.key({ scopes: ['passes:read'], orgId });
  const testKey = await api.key({ scopes: ['passes:read'], orgId, mode: 'test' });
  const passes = [];
  for (let i = 0; i < n; i++) {
    passes.push(await api.rig.kit.pass({ orgId }));
    api.rig.kit.clock.advance(1000);
  }
  const get = (query = '', headers = key) =>
    api.call('GET', `${EVENTS}${query}`, undefined, headers);
  return { orgId, key, testKey, passes, get };
}

describe('GET /events', () => {
  it('pages ascending by cursor until the tail, and an empty page echoes the cursor', async () => {
    const s = await scene(5);
    const p1 = await s.get('?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.json.items).toHaveLength(2);
    expect(p1.json.hasMore).toBe(true);
    expect(p1.json.nextCursor).toMatch(/^ev2\.[A-Za-z0-9_-]{22}$/);
    expect(p1.json.items[0]).toMatchObject({
      type: 'pass.issued',
      apiVersion: '2026-12-01',
      orgId: s.orgId,
      mode: 'live',
      pass: { id: s.passes[0]?.id, templateId: expect.any(String) },
    });
    const p2 = await s.get(`?limit=2&after=${p1.json.nextCursor}`);
    const p3 = await s.get(`?limit=2&after=${p2.json.nextCursor}`);
    expect(p2.json.hasMore).toBe(true);
    expect(p3.json).toMatchObject({ hasMore: false });
    expect(p3.json.items).toHaveLength(1);
    const ids = [...p1.json.items, ...p2.json.items, ...p3.json.items].map(
      (e: { pass: { id: string } }) => e.pass.id,
    );
    expect(ids).toEqual(s.passes.map((p) => p.id));
    const empty = await s.get(`?after=${p3.json.nextCursor}`);
    expect(empty.json).toEqual({ items: [], nextCursor: p3.json.nextCursor, hasMore: false });
  });

  it('starts at the oldest event with no cursor, and at the start on an empty feed', async () => {
    const empty = await scene();
    const start = (await empty.get()).json;
    expect(start).toEqual({
      items: [],
      nextCursor: expect.stringMatching(/^ev2\./),
      hasMore: false,
    });
    // The start cursor round-trips, and the older ev1.0 still means the start.
    expect((await empty.get(`?after=${start.nextCursor}`)).json.nextCursor).toBe(start.nextCursor);
    expect((await empty.get('?after=ev1.0')).json.nextCursor).toBe(start.nextCursor);
    const s = await scene(2);
    const all = await s.get();
    expect(all.json.items).toHaveLength(2);
  });

  it('after=now returns no items and the head, so a poller sees only what comes next', async () => {
    const s = await scene(2);
    const head = await s.get('?after=now');
    expect(head.json).toMatchObject({ items: [], hasMore: false });
    expect(head.json.nextCursor).toMatch(/^ev2\./);
    const added = await api.rig.kit.pass({ orgId: s.orgId });
    const next = await s.get(`?after=${head.json.nextCursor}`);
    expect(next.json.items.map((e: { pass: { id: string } }) => e.pass.id)).toEqual([added.id]);
    const emptyNow = await (await scene()).get('?after=now');
    expect(emptyNow.json.nextCursor).toMatch(/^ev2\.[A-Za-z0-9_-]{22}$/);
  });

  it('shows a late (backdated) event after the cursor, with its real time', async () => {
    const s = await scene(2);
    const head = (await s.get('?after=now')).json.nextCursor as string;
    const now = api.rig.kit.clock.now();
    await recordPassEvent(api.rig.kit.ctx, {
      orgId: s.orgId,
      passId: s.passes[0]?.id ?? '',
      mode: 'live',
      kind: 'pass.voided',
      data: {},
      at: now - 3_600_000,
    });
    const page = await s.get(`?after=${head}`);
    expect(page.json.items).toHaveLength(1);
    expect(page.json.items[0]).toMatchObject({ type: 'pass.voided', createdAt: now - 3_600_000 });
  });

  it('filters by types and passId, and refuses bad input', async () => {
    const s = await scene(3);
    await recordPassEvent(api.rig.kit.ctx, {
      orgId: s.orgId,
      passId: s.passes[1]?.id ?? '',
      mode: 'live',
      kind: 'pass.voided',
      data: {},
    });
    expect((await s.get('?types=pass.voided')).json.items).toHaveLength(1);
    expect((await s.get('?types=pass.voided,pass.issued')).json.items).toHaveLength(4);
    const one = await s.get(`?passId=${s.passes[1]?.id}`);
    expect(one.json.items.map((e: { type: string }) => e.type)).toEqual([
      'pass.issued',
      'pass.voided',
    ]);
    for (const q of [
      '?types=pass.nope',
      '?types=webhook.test',
      '?after=abc',
      '?after=ev1.-1',
      '?limit=0',
      '?limit=201',
      '?apiVersion=2020-01-01',
    ])
      expect((await s.get(q)).status, q).toBe(422);
    expect((await s.get('?apiVersion=2026-12-01')).status).toBe(200);
  });

  it('fences by org and by mode', async () => {
    const a = await scene(2);
    const b = await scene(3);
    await api.rig.kit.pass({ orgId: a.orgId, mode: 'test' });
    expect((await a.get()).json.items).toHaveLength(2);
    expect((await b.get()).json.items).toHaveLength(3);
    const test = await a.get('', a.testKey);
    expect(test.json.items).toHaveLength(1);
    expect(test.json.items[0].mode).toBe('test');
    // Another org's pass id finds nothing here.
    expect((await a.get(`?passId=${b.passes[0]?.id}`)).json.items).toEqual([]);
    expect(await a.get(`?orgId=${b.orgId}`)).toMatchObject({ status: 403 });
  });

  it('hides quarantined passes', async () => {
    const s = await scene(2);
    await run(api.rig.db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      s.passes[0]?.id ?? '',
    ]);
    const page = await s.get();
    expect(page.json.items).toHaveLength(1);
    expect(page.json.items[0].pass.id).toBe(s.passes[1]?.id);
    const id = (
      await all<{ event_id: string }>(
        api.rig.db,
        'SELECT event_id FROM event_feed WHERE pass_id = ?',
        [s.passes[0]?.id ?? ''],
      )
    )[0]?.event_id;
    expect((await api.call('GET', `${EVENTS}/${id}`, undefined, s.key)).status).toBe(404);
    await run(api.rig.db, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [
      s.passes[0]?.id ?? '',
    ]);
  });

  it('carries no holder name, email or personalization', async () => {
    const orgId = await api.otherOrg();
    const key = await api.key({ scopes: ['passes:read'], orgId });
    await api.rig.kit.pass({
      orgId,
      holderEmail: 'private-holder@example.com',
      memberName: 'Zelda Privatename',
    });
    const res = await api.call('GET', EVENTS, undefined, key);
    expect(res.json.items).toHaveLength(1);
    expect(res.text).not.toContain('private-holder');
    expect(res.text).not.toContain('Privatename');
  });
});

describe('GET /events/{id}', () => {
  it('returns one event for its org and mode, and 404 elsewhere', async () => {
    const s = await scene(1);
    const other = await scene(1);
    const [event] = (await s.get()).json.items;
    const one = await api.call('GET', `${EVENTS}/${event.id}`, undefined, s.key);
    expect(one.status).toBe(200);
    expect(one.json).toEqual(event);
    expect(
      (await api.call('GET', `${EVENTS}/${event.id}?apiVersion=2026-12-01`, undefined, s.key))
        .status,
    ).toBe(200);
    expect((await api.call('GET', `${EVENTS}/${event.id}`, undefined, other.key)).status).toBe(404);
    expect((await api.call('GET', `${EVENTS}/${event.id}`, undefined, s.testKey)).status).toBe(404);
    expect((await api.call('GET', `${EVENTS}/nope`, undefined, s.key)).status).toBe(404);
  });

  it('matches what the webhook delivered for the same event', async () => {
    const s = await scene();
    const admin = await api.member(['org_admin'], { orgId: s.orgId });
    const made = await api.call(
      'POST',
      BASE,
      { orgId: s.orgId, url: 'https://hooks.example.com/feed', eventTypes: ['pass.issued'] },
      admin,
    );
    const pass = await api.rig.kit.pass({ orgId: s.orgId });
    const feed = (await s.get()).json.items[0];
    const detail = await api.call(
      'GET',
      `${BASE}/${made.json.endpoint.id}/deliveries/${feed.id}`,
      undefined,
      admin,
    );
    expect(detail.json.payload).toEqual(feed);
    expect(feed.pass.id).toBe(pass.id);
  });
});

describe('OpenAPI', () => {
  it('lists every webhook and feed route', async () => {
    const doc = await api.call('GET', '/api/v1/openapi.json');
    const paths = Object.keys(doc.json.paths);
    const expected = [
      '/api/v1/webhook-endpoints',
      '/api/v1/webhook-endpoints/{id}',
      '/api/v1/webhook-endpoints/{id}/secret',
      '/api/v1/webhook-endpoints/{id}/test',
      '/api/v1/webhook-endpoints/{id}/deliveries',
      '/api/v1/webhook-endpoints/{id}/deliveries/{eventId}',
      '/api/v1/webhook-endpoints/{id}/deliveries/{eventId}/replay',
      '/api/v1/webhook-endpoints/{id}/replay',
      '/api/v1/events',
      '/api/v1/events/{id}',
    ];
    for (const p of expected) expect(paths, p).toContain(p);
    const methods = (p: string) => Object.keys(doc.json.paths[p]).sort();
    expect(methods('/api/v1/webhook-endpoints')).toEqual(['get', 'post']);
    expect(methods('/api/v1/webhook-endpoints/{id}')).toEqual(['delete', 'get', 'patch']);
  });
});
