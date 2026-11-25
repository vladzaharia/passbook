import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiRailSchema } from '../../../shared/contracts/index.ts';
import { insertLog, type NewLog } from './repo-request-log.ts';
import { logKit } from './request-log-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

const MIN = 60_000;
const entry = (orgId: string, keyId: string, over: Partial<NewLog>): NewLog => {
  const id = t.kit.f.ids.id();
  return {
    id,
    orgId,
    keyId,
    via: null,
    mode: 'test',
    requestId: id,
    method: 'GET',
    route: '/api/v1/passes',
    path: '/api/v1/passes',
    query: null,
    status: 200,
    code: null,
    durationMs: 4,
    at: t.kit.clock.now(),
    requestBody: null,
    responseBody: null,
    ...over,
  };
};

describe('GET /developer/rail, the last hour', () => {
  it('counts five-minute buckets, oldest first, and leaves out the portal’s own reads', async () => {
    const d = await t.developer();
    const now = t.kit.clock.now();
    const rows = [
      entry(d.made.orgId, d.key.id, { at: now - 58 * MIN }),
      entry(d.made.orgId, d.key.id, { at: now - 31 * MIN }),
      entry(d.made.orgId, d.key.id, { at: now - 31 * MIN, via: 'try' }),
      entry(d.made.orgId, d.key.id, { at: now - MIN }),
      // The portal polling its own captures: not a call the developer made.
      entry(d.made.orgId, d.key.id, { at: now - MIN, via: 'try', client: 'portal' }),
      // Older than the hour.
      entry(d.made.orgId, d.key.id, { at: now - 61 * MIN }),
    ];
    for (const r of rows) await insertLog(t.kit.env.DB, r);

    const rail = ApiRailSchema.parse(
      await (await t.call('/developer/rail', { headers: d.browser })).json(),
    );
    expect(rail.callsLastHour).toBe(4);
    expect(rail.series).toEqual([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1]);
  });

  it('is twelve zeros for a quiet sandbox', async () => {
    const d = await t.developer();
    const rail = ApiRailSchema.parse(
      await (await t.call('/developer/rail', { headers: d.browser })).json(),
    );
    expect(rail.series).toEqual(Array.from({ length: 12 }, () => 0));
    expect(rail.callsLastHour).toBe(0);
  });
});
