import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import {
  createFetchClient,
  type OperationsClient,
  OperationsHttpError,
  OperationsProvider,
} from './client.ts';
import { fixtureOperation, SANDBOX_DELETE, STATE_FIXTURES } from './fixtures.test-support.ts';
import { pollDelay } from './poll.ts';
import { resetOperationCache, seedOperation, trackOperation } from './store.ts';
import { useOperation, useOperations } from './use-operation.ts';

function stub(over: Partial<OperationsClient> = {}): OperationsClient {
  return {
    get: vi.fn(async () => ({ operation: STATE_FIXTURES.running(), etag: '"op:3"' })),
    list: vi.fn(async () => []),
    cancel: vi.fn(),
    retry: vi.fn(),
    ...over,
  } as OperationsClient;
}
const wrapper =
  (client: OperationsClient) =>
  ({ children }: { children: ReactNode }) => (
    <OperationsProvider client={client}>{children}</OperationsProvider>
  );

beforeEach(() => {
  vi.useFakeTimers();
  resetOperationCache();
});
afterEach(() => vi.useRealTimers());

describe('pollDelay', () => {
  it('backs off 1 s, 2 s, 5 s, and respects the floor, a hidden tab and Retry-After', () => {
    expect(pollDelay({ sinceStartMs: 0 })).toBe(1000);
    expect(pollDelay({ sinceStartMs: 9_999 })).toBe(1000);
    expect(pollDelay({ sinceStartMs: 10_000 })).toBe(2000);
    expect(pollDelay({ sinceStartMs: 59_999 })).toBe(2000);
    expect(pollDelay({ sinceStartMs: 60_000 })).toBe(5000);
    expect(pollDelay({ sinceStartMs: 0, floorMs: 60_000 })).toBe(60_000);
    expect(pollDelay({ sinceStartMs: 0, hidden: true })).toBe(30_000);
    expect(pollDelay({ sinceStartMs: 0, retryAfterMs: 12_000 })).toBe(12_000);
  });
});

describe('useOperation', () => {
  it('polls, sends the etag, keeps the 304 body, and stops at a terminal status', async () => {
    const calls: (string | null | undefined)[] = [];
    const replies = [
      { operation: STATE_FIXTURES.running(), etag: '"a"' },
      { operation: null, etag: '"a"' },
      {
        operation: { ...STATE_FIXTURES.succeeded(), id: STATE_FIXTURES.running().id, revision: 9 },
        etag: '"b"',
      },
    ];
    const client = stub({
      get: vi.fn(async (_id, o) => {
        calls.push(o.etag);
        return replies.shift() ?? { operation: null, etag: '"b"' };
      }),
    });
    const { result } = renderHook(() => useOperation(STATE_FIXTURES.running().id), {
      wrapper: wrapper(client),
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.operation?.status).toBe('running');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.operation?.status).toBe('running');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.operation?.status).toBe('succeeded');
    expect(calls).toEqual([null, '"a"', '"a"']);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it('shows a seeded operation at once, with no request for a finished one', async () => {
    const done = STATE_FIXTURES.succeeded();
    seedOperation(done);
    const client = stub();
    const { result } = renderHook(() => useOperation(done.id), { wrapper: wrapper(client) });
    expect(result.current.operation?.status).toBe('succeeded');
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(client.get).not.toHaveBeenCalled();
  });

  it('never replaces a newer revision with an older one', () => {
    const op = STATE_FIXTURES.running();
    seedOperation({ ...op, revision: 5, text: 'new' });
    seedOperation({ ...op, revision: 4, text: 'old' });
    const { result } = renderHook(() => useOperation(null));
    expect(result.current.operation).toBeUndefined();
    const { result: again } = renderHook(() => useOperation(op.id), {
      wrapper: wrapper(stub({ get: vi.fn(async () => ({ operation: null, etag: null })) })),
    });
    expect(again.current.operation?.text).toBe('new');
  });

  it('reports a 404 as missing and a 429 waits out its Retry-After', async () => {
    const gone = stub({
      get: vi.fn(async () => {
        throw new OperationsHttpError(404, null);
      }),
    });
    const a = renderHook(() => useOperation('x'), { wrapper: wrapper(gone) });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(a.result.current.missing).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(gone.get).toHaveBeenCalledOnce();

    const limited = stub({
      get: vi.fn(async () => {
        throw new OperationsHttpError(429, 12_000);
      }),
    });
    renderHook(() => useOperation('y'), { wrapper: wrapper(limited) });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(limited.get).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(limited.get).toHaveBeenCalledTimes(2);
  });
});

describe('useOperations', () => {
  it('fetches once, polls every 5 s only while one is active, and seeds the cache', async () => {
    const running = [STATE_FIXTURES.running()];
    const list = vi.fn(async () => running.splice(0, 1));
    const client = stub({ list });
    const { result } = renderHook(() => useOperations({ active: true, mine: true }), {
      wrapper: wrapper(client),
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.operations).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.operations).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(list).toHaveBeenCalledTimes(2);
    // A start mutation seeds the cache and asks for a look.
    trackOperation(STATE_FIXTURES.running());
    await act(async () => result.current.refetch());
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('the fetch client', () => {
  it('sends If-None-Match, returns null on 304, and writes with a CSRF token and an idempotency key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const op = fixtureOperation(SANDBOX_DELETE, { status: 'running' });
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if ((init.headers as Record<string, string>)['if-none-match'])
        return new Response(null, { status: 304 });
      return new Response(JSON.stringify(op), {
        status: 200,
        headers: { etag: '"op:3"' },
      });
    }) as unknown as typeof fetch;
    const client = createFetchClient({ fetch: doFetch, csrf: async () => 'tok' });
    const first = await client.get(op.id, {});
    expect(first.etag).toBe('"op:3"');
    const second = await client.get(op.id, { etag: first.etag });
    expect(second.operation).toBeNull();
    await client.retry(op.id);
    const post = seen.at(-1);
    expect(post?.url).toBe(`/api/v1/operations/${op.id}/retry`);
    const headers = post?.init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');
    expect(headers['idempotency-key']).toMatch(/[0-9a-f-]{36}/);
  });

  it('throws the status and Retry-After of a refusal', async () => {
    const doFetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '7' },
      })) as unknown as typeof fetch;
    const client = createFetchClient({ fetch: doFetch });
    await expect(client.list({ active: true, mine: true })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 7000,
    });
  });
});
