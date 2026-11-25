import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LISTEN_MS, QUIET_MS, useListener } from './use-listener.ts';

const row = (id: string) => ({ id, method: 'POST', path: '/api/v1/passes', status: 201 });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useListener', () => {
  it('asks for calls after the newest one it knew, oldest first, and moves its cursor', async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const pages = [[], [row('b'), row('a-new')], []];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json({ items: pages.shift() ?? [] });
      }),
    );
    const { result } = renderHook(() => useListener(true, 'a'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(urls[0]).toContain('source=key');
    expect(urls[0]).toContain('after=a');
    expect(result.current.heard.map((e) => e.id)).toEqual(['a-new', 'b']);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(urls.at(-1)).toContain('after=b');
  });

  it('stops after ten minutes, and listens again on request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    );
    const { result } = renderHook(() => useListener(true, null));
    await act(async () => vi.advanceTimersByTimeAsync(LISTEN_MS + 4000));
    expect(result.current.over).toBe(true);
    act(() => result.current.again());
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(result.current.over).toBe(false);
  });

  it('turns quiet after 45 s with nothing heard, and not when a call arrives first', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    );
    const { result } = renderHook(() => useListener(true, null));
    await act(async () => vi.advanceTimersByTimeAsync(QUIET_MS - 2000));
    expect(result.current.quiet).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(result.current.quiet).toBe(true);
    expect(result.current.over).toBe(false);
  });

  it('is not quiet when a call arrives before 45 s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [row('c1')] })),
    );
    const { result } = renderHook(() => useListener(true, null));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(result.current.heard).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(QUIET_MS + 2000));
    expect(result.current.quiet).toBe(false);
  });

  it('does nothing while inactive', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    renderHook(() => useListener(false, null));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
