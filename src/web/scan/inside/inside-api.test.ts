import { describe, expect, it, vi } from 'vitest';
import { createScanApi, ScanApiError } from '../api/scan-api.ts';
import { insidePort } from './inside-api.ts';
import { insideRow } from './inside-fake.test-support.ts';
import { InsideListSchema, InsideWireSchema } from './inside-types.ts';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const WIRE = {
  items: [
    {
      passId: insideRow(1).passId,
      holder: 'Maya Okafor',
      photoUrl: null,
      plan: 'Staff',
      place: 'zone:floor3',
      placeName: 'Floor 3',
      parentName: 'HQ',
      since: 1_000,
      dueAt: 5_000,
      via: 'Front desk',
      flags: ['long_stay'],
    },
  ],
  count: 42,
  rev: 9,
  places: [{ place: 'zone:floor3', name: 'Floor 3', inNow: 18, capacity: null, rev: 9 }],
  nextCursor: null,
};

function setup(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createScanApi({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch,
    csrf: () => 'csrf-1',
    sleep: async () => {},
  });
  return { api, calls };
}

describe('the wire shape WP-G serves', () => {
  it('parses and maps the zone, its parent, the count and the places', () => {
    const list = InsideListSchema.parse(WIRE);
    expect(list.items[0]).toMatchObject({
      holder: 'Maya Okafor',
      zone: { name: 'Floor 3', parent: 'HQ' },
      dueAt: 5000,
      host: null,
      flags: ['long_stay'],
    });
    expect(list.total).toBe(42);
    expect(list.places[0]).toMatchObject({ inNow: 18, rev: 9 });
    expect(list.asOf).toBeGreaterThan(0);
  });
  it('refuses a row with an unknown flag or more than 100 rows', () => {
    expect(
      InsideWireSchema.safeParse({ ...WIRE, items: [{ ...WIRE.items[0], flags: ['x'] }] }).success,
    ).toBe(false);
    expect(
      InsideWireSchema.safeParse({ ...WIRE, items: Array(101).fill(WIRE.items[0]) }).success,
    ).toBe(false);
  });
});

describe("the Who's in calls", () => {
  it('GETs the list with place, q, cursor and limit, and sends no csrf', async () => {
    const { api, calls } = setup(() => json(WIRE));
    const list = await insidePort(api).inside(
      { place: 'zone:floor3', q: 'may', cursor: 'c1', limit: 50 },
      {},
    );
    expect(calls[0]?.url).toBe(
      '/api/v1/scan/live/inside?place=zone%3Afloor3&q=may&cursor=c1&limit=50',
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(list.items).toHaveLength(1);
  });
  it('asks for every place with a bare path', async () => {
    const { api, calls } = setup(() => json(WIRE));
    await api.inside({});
    expect(calls[0]?.url).toBe('/api/v1/scan/live/inside');
  });
  it('POSTs a mark-out with the key, the pass and the place, under csrf', async () => {
    const { api, calls } = setup(() => json({ error: 'x' }, { status: 500 }));
    const body = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      passId: insideRow(1).passId,
      place: 'zone:floor3',
    };
    await expect(api.markOut(body)).rejects.toBeInstanceOf(ScanApiError);
    expect(calls[0]?.url).toBe('/api/v1/scan/mark-out');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({ 'x-csrf-token': 'csrf-1' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
  });
  it('takes a mark-out back through the ordinary undo route', async () => {
    const { api, calls } = setup(() => json({}, { status: 500 }));
    await insidePort(api)
      .undoMarkOut('scan-9', 'k1')
      .catch(() => undefined);
    expect(calls[0]?.url).toBe('/api/v1/scan/scans/scan-9/undo');
  });
  it('carries the problem code of a 409 NOT_INSIDE and a 403 SCREEN_ONLY', async () => {
    const problem = (code: string, status: number) => json({ code, title: code }, { status });
    const a = setup(() => problem('NOT_INSIDE', 409));
    await expect(
      a.api.markOut({
        idempotencyKey: '01900000-0000-7000-8000-000000000001',
        passId: 'p',
        place: 'zone:a',
      }),
    ).rejects.toMatchObject({ code: 'NOT_INSIDE', status: 409 });
    const b = setup(() => problem('SCREEN_ONLY', 403));
    await expect(b.api.inside({})).rejects.toMatchObject({ code: 'SCREEN_ONLY', status: 403 });
  });
});

void vi;
