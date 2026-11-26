import { afterEach, describe, expect, it, vi } from 'vitest';
import { remainingFromHeaders, waitFromHeaders } from '../lib/http.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { harness, NOW } from './harness.ts';
import connector from './index.ts';

const base = { baseUrl: 'https://api.example.com/v1' };
const withList = { ...base, list: { path: '/m', recordsPointer: '/data' } };
const page = { body: { data: [{ id: 'a' }] } };

afterEach(() => vi.useRealTimers());

describe('reading wait headers', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('reads Retry-After as seconds or an HTTP-date, capped at an hour', () => {
    expect(waitFromHeaders(h({ 'retry-after': '7' }), NOW)).toBe(7000);
    expect(waitFromHeaders(h({ 'retry-after': new Date(NOW + 12_000).toUTCString() }), NOW)).toBe(
      12_000,
    );
    expect(waitFromHeaders(h({ 'retry-after': '999999' }), NOW)).toBe(3_600_000);
    expect(
      waitFromHeaders(h({ 'retry-after': new Date(NOW - 5000).toUTCString() }), NOW),
    ).toBeUndefined();
    expect(waitFromHeaders(h({ 'retry-after': 'soon' }), NOW)).toBeUndefined();
    expect(waitFromHeaders(h({ 'retry-after': '0' }), NOW)).toBeUndefined();
  });

  it('reads reset headers as a delta, or as an epoch in seconds or ms', () => {
    expect(waitFromHeaders(h({ 'ratelimit-reset': '30' }), NOW)).toBe(30_000);
    expect(waitFromHeaders(h({ 'x-ratelimit-reset': String(NOW / 1000 + 45) }), NOW)).toBe(45_000);
    expect(waitFromHeaders(h({ 'x-ratelimit-reset': String(NOW + 8000) }), NOW)).toBe(8000);
    expect(
      waitFromHeaders(h({ 'x-ratelimit-reset': String(NOW / 1000 - 45) }), NOW),
    ).toBeUndefined();
    expect(waitFromHeaders(h({ 'retry-after': '3', 'x-ratelimit-reset': '90' }), NOW)).toBe(3000);
  });

  it('reads the remaining count', () => {
    expect(remainingFromHeaders(h({ 'x-ratelimit-remaining': '0' }))).toBe(0);
    expect(remainingFromHeaders(h({ 'ratelimit-remaining': '12' }))).toBe(12);
    expect(remainingFromHeaders(h({}))).toBeUndefined();
  });
});

describe('429 responses', () => {
  it('waits a short Retry-After once inside the connector and then succeeds', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { ctx, calls } = harness(withList, {}, () =>
      n++ === 0 ? { status: 429, headers: { 'retry-after': '2' } } : page,
    );
    const run = connector.listChanges?.(ctx, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await run)?.changes).toEqual([{ ref: 'a', record: { id: 'a' } }]);
    expect(calls).toHaveLength(2);
  });

  it('retries only once', async () => {
    vi.useFakeTimers();
    const { ctx, calls } = harness(withList, {}, () => ({
      status: 429,
      headers: { 'retry-after': '1' },
    }));
    const run = connector.listChanges?.(ctx, null).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1000 });
    expect(calls).toHaveLength(2);
  });

  it('hands a long wait to the scheduler without retrying', async () => {
    const { ctx, calls } = harness(withList, {}, () => ({
      status: 429,
      headers: { 'retry-after': '6' },
    }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 6000,
    });
    expect(calls).toHaveLength(1);
  });

  it('takes the wait from a reset header when there is no Retry-After', async () => {
    const { ctx } = harness(withList, {}, () => ({
      status: 429,
      headers: { 'x-ratelimit-reset': '90' },
    }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      retryAfterMs: 90_000,
    });
  });

  it('a 429 without a wait is not retried', async () => {
    const { ctx, calls } = harness(withList, {}, () => ({ status: 429 }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('an exhausted window on a 2xx', () => {
  const exhausted = (reset: string) => ({
    ...page,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
  });

  it('saves the wait in the cursor and sleeps it before the next request', async () => {
    vi.useFakeTimers();
    const { ctx, calls } = harness(
      { ...withList, list: { ...withList.list, pagination: { style: 'offset', size: 1 } } },
      {},
      (u) => (u.searchParams.get('offset') === '0' ? exhausted('10') : page),
    );
    const first = await connector.listChanges?.(ctx, null);
    expect(decodeCursor(first?.cursor ?? null).state.w).toBe(NOW + 10_000);
    const next = connector.listChanges?.(ctx, first?.cursor ?? null);
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(calls).toHaveLength(2);
  });

  it('refuses a wait over 30 s without making a request', async () => {
    const { ctx, calls } = harness(withList, {}, () => page);
    const cursor = encodeCursor({ p: null, w: NOW + 120_000 });
    await expect(connector.listChanges?.(ctx, cursor)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 120_000,
    });
    expect(calls).toHaveLength(0);
  });

  it('ignores a wait that has passed, and a remaining count above zero', async () => {
    const { ctx, calls } = harness(withList, {}, () => ({
      ...page,
      headers: { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': '10' },
    }));
    const res = await connector.listChanges?.(ctx, encodeCursor({ p: null, w: NOW - 1 }));
    expect(calls).toHaveLength(1);
    expect(decodeCursor(res?.cursor ?? null).state.w).toBeUndefined();
  });

  it('an aborted run stops sleeping', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const { ctx, calls } = harness(withList, {}, () => page, undefined, { signal: abort.signal });
    const run = connector
      .listChanges?.(ctx, encodeCursor({ p: null, w: NOW + 20_000 }))
      .catch((e: unknown) => e);
    abort.abort();
    expect(await run).toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toHaveLength(0);
  });
});
