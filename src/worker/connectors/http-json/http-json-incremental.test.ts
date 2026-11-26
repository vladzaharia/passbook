import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { drain, harness, NOW } from './harness.ts';
import connector from './index.ts';

const base = { baseUrl: 'https://api.example.com/v1' };
const T1 = Date.UTC(2025, 11, 1, 12, 0, 0);
const T2 = Date.UTC(2025, 11, 2, 12, 0, 0);

const listOf = (inc: object, extra: object = {}) => ({
  ...base,
  list: {
    path: '/m',
    recordsPointer: '/data',
    pagination: { style: 'offset', size: 1 },
    incremental: { param: 'updated_since', field: '/updated_at', ...inc },
    ...extra,
  },
});

describe('incremental sync by updated-since', () => {
  const rows = [
    { id: 'a', updated_at: new Date(T1).toISOString() },
    { id: 'b', updated_at: new Date(T2).toISOString() },
  ];
  const serve = (u: URL) => {
    const o = Number(u.searchParams.get('offset'));
    return { body: { data: rows.slice(o, o + 1) } };
  };

  it('sends no filter on the first run, then asks from the high-water mark minus the overlap', async () => {
    const { ctx, calls } = harness(listOf({ overlapSeconds: 300 }), {}, serve);
    const first = await drain(ctx);
    expect(calls.every((c) => !new URL(c.url).searchParams.has('updated_since'))).toBe(true);
    expect(decodeCursor(first.cursor).state).toEqual({ p: null, h: T2 });
    calls.length = 0;
    await drain(ctx, first.cursor);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('updated_since')).toBe(
      new Date(T2 - 300_000).toISOString(),
    );
  });

  it('formats the filter as unix seconds or milliseconds and reads numeric fields', async () => {
    for (const [format, value, expected] of [
      ['unix', T2 / 1000, String((T2 - 300_000) / 1000)],
      ['unix-ms', T2, String(T2 - 300_000)],
    ] as const) {
      const { ctx, calls } = harness(
        listOf({ format }, { pagination: { style: 'none' } }),
        {},
        () => ({
          body: { data: [{ id: 'a', updated_at: value }] },
        }),
      );
      const first = await connector.listChanges?.(ctx, null);
      expect(decodeCursor(first?.cursor ?? null).state.h).toBe(T2);
      await connector.listChanges?.(ctx, first?.cursor ?? null);
      expect(new URL(calls[1]?.url ?? '').searchParams.get('updated_since')).toBe(expected);
    }
  });

  it('moves the mark only when the whole listing finished', async () => {
    const { ctx, calls } = harness(listOf({}), {}, serve);
    const first = await connector.listChanges?.(ctx, null);
    // Page one is applied: the run has seen T1 but the mark has not moved.
    expect(first?.hasMore).toBe(true);
    expect(decodeCursor(first?.cursor ?? null).state).toMatchObject({ p: { n: 1, k: 1 }, m: T1 });
    expect(decodeCursor(first?.cursor ?? null).state.h).toBeUndefined();
    // A failed second page resumes with the same filter, whatever the first page saw.
    const failing = harness(listOf({}), {}, (u) =>
      u.searchParams.get('offset') === '1' ? { status: 500 } : serve(u),
    );
    const part = await connector.listChanges?.(failing.ctx, null);
    await expect(connector.listChanges?.(failing.ctx, part?.cursor ?? null)).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
    const done = await drain(ctx, first?.cursor ?? null);
    expect(decodeCursor(done.cursor).state).toEqual({ p: null, h: T2 });
    expect(calls.every((c) => !new URL(c.url).searchParams.has('updated_since'))).toBe(true);
  });

  it('ignores unreadable fields and times far in the future, and never moves the mark back', async () => {
    const future = new Date(NOW + 3 * 86_400_000).toISOString();
    const { ctx } = harness(listOf({}), {}, () => ({
      body: {
        data: [
          { id: 'a', updated_at: future },
          { id: 'b', updated_at: 'yesterday-ish' },
          { id: 'c' },
          { id: 'd', updated_at: new Date(T1).toISOString() },
        ],
      },
    }));
    const res = await connector.listChanges?.(ctx, null);
    expect(res?.changes).toHaveLength(4);
    const lower = encodeCursor({ p: null, h: T2 });
    const again = await connector.listChanges?.(ctx, lower);
    expect(decodeCursor(again?.cursor ?? null).state.h).toBe(T2);
  });

  it('is refused on a feed listing', () => {
    expect(connector.configSchema.safeParse(listOf({}, { listing: 'feed' })).success).toBe(false);
  });
});
