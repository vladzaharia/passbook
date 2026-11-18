import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyedDigest } from '../../platform/crypto.ts';
import { all } from '../../platform/db.ts';
import { type Api, setupApi } from './api-test-fixtures.ts';
import { encodeCursor } from './cursor.ts';
import { type Net, stubNet } from './deliver-test-fixtures.ts';

let api: Api;
let net: Net;
beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
});
afterAll(() => net.restore());

async function scene(n: number) {
  const orgId = await api.otherOrg();
  const key = await api.key({ scopes: ['passes:read'], orgId });
  const testKey = await api.key({ scopes: ['passes:read'], orgId, mode: 'test' });
  for (let i = 0; i < n; i++) await api.rig.kit.pass({ orgId });
  const get = (q: string, h = key) => api.call('GET', `/api/v1/events${q}`, undefined, h);
  return { orgId, key, testKey, get };
}

describe('ev2 cursors', () => {
  it('are a keyed permutation: neighbouring seqs share no structure, and another org fails the tag', async () => {
    const a = await scene(4);
    const b = await scene(1);
    const env = api.rig.kit.env;
    const fence = { orgId: a.orgId, mode: 'live' as const };
    const c1 = await encodeCursor(env, fence, 1000);
    const c2 = await encodeCursor(env, fence, 1001);
    expect(c1).toHaveLength(22);
    expect(c1).not.toBe(c2);
    // No common prefix beyond chance: the distance of two seqs is not readable.
    expect(c1.slice(0, 6)).not.toBe(c2.slice(0, 6));
    expect(await encodeCursor(env, { ...fence, mode: 'test' }, 1000)).not.toBe(c1);
    const page = await a.get('?limit=2');
    expect((await a.get(`?after=${page.json.nextCursor}`)).status).toBe(200);
    // Another org's key, and the same org in the other mode, refuse it.
    expect((await b.get(`?after=${page.json.nextCursor}`)).status).toBe(422);
    expect((await a.get(`?after=${page.json.nextCursor}`, a.testKey)).status).toBe(422);
  });

  it('refuse a tampered or malformed body', async () => {
    const a = await scene(3);
    const { nextCursor } = (await a.get('?limit=1')).json as { nextCursor: string };
    const body = nextCursor.slice(4);
    const flipped = `ev2.${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    for (const after of [
      flipped,
      'ev2.short',
      `ev2.${'A'.repeat(22)}`,
      'ev2.!!!!!!!!!!!!!!!!!!!!!!',
    ])
      expect((await a.get(`?after=${after}`)).status, after).toBe(422);
  });

  it('still accept the older ev1 cursors of this org', async () => {
    const a = await scene(3);
    const seqs = (
      await all<{ seq: number }>(
        api.rig.db,
        'SELECT seq FROM event_feed WHERE org_id = ? ORDER BY seq',
        [a.orgId],
      )
    ).map((r) => r.seq);
    const hex = (await keyedDigest(api.rig.kit.env, 'webhook.cursor.v1', `${a.orgId}:live`)).slice(
      0,
      10,
    );
    const legacy = `ev1.${BigInt(seqs[0] as number) ^ BigInt(`0x${hex}`)}`;
    const page = await a.get(`?after=${legacy}`);
    expect(page.status).toBe(200);
    expect(page.json.items).toHaveLength(2);
    expect(page.json.nextCursor).toMatch(/^ev2\./);
    expect((await a.get('?after=ev1.0')).json.items).toHaveLength(3);
  });
});
