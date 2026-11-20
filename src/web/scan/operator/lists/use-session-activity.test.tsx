import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanApi } from '../../api/scan-api.ts';
import { HUB_POLL_MS, POLL_STEPS_MS, useSessionActivity } from './use-session-activity.ts';

const page = { items: [] };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fake(behave: (call: { signal?: AbortSignal }, problems: boolean) => Promise<typeof page>) {
  const calls: { problems: boolean; signal?: AbortSignal | undefined }[] = [];
  const api = {
    activity: (call: { signal?: AbortSignal; problems?: boolean } = {}) => {
      const problems = call.problems === true;
      calls.push({ problems, signal: call.signal });
      return behave(call, problems);
    },
  } as unknown as ScanApi;
  return { api, calls };
}

describe('useSessionActivity', () => {
  it('loads the newest scans and the problems page, then repeats', async () => {
    const { api, calls } = fake(async () => page);
    renderHook(() => useSessionActivity(api, true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls.map((c) => c.problems)).toEqual([false, true]);
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0]));
    expect(calls).toHaveLength(4);
  });

  it('a tick never aborts a request still in flight', async () => {
    const { api, calls } = fake(() => new Promise(() => undefined));
    renderHook(() => useSessionActivity(api, true));
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0] + 1));
    // Two ticks later the first request is still the only one, and was not aborted.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it('shows a failure as unavailable and backs off 4, 8, 16 s', async () => {
    const { api, calls } = fake(() => Promise.reject(new Error('down')));
    const { result } = renderHook(() => useSessionActivity(api, true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.unavailable).toBe(true);
    const seen = () => calls.filter((c) => !c.problems).length;
    expect(seen()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0] + 100));
    expect(seen()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[1] - POLL_STEPS_MS[0]));
    expect(seen()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[1] + 100));
    expect(seen()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[2] - POLL_STEPS_MS[1]));
    expect(seen()).toBe(3);
  });

  it('times a request out after 8 s', async () => {
    const { api } = fake(
      (call) =>
        new Promise((_, reject) =>
          call.signal?.addEventListener('abort', () => reject(new Error('abort'))),
        ),
    );
    const { result } = renderHook(() => useSessionActivity(api, true));
    await act(() => vi.advanceTimersByTimeAsync(8001));
    expect(result.current.unavailable).toBe(true);
  });

  it('pauses while offline, and loads at once when the network returns', async () => {
    const { api, calls } = fake(async () => page);
    const { rerender } = renderHook(({ online }) => useSessionActivity(api, online), {
      initialProps: { online: false },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const first = calls.length;
    await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0] * 3));
    expect(calls.length).toBe(first);
    rerender({ online: true });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.length).toBeGreaterThan(first);
  });

  it('an explicit refresh replaces a request in flight', async () => {
    let n = 0;
    const { api, calls } = fake(() =>
      ++n <= 2 ? new Promise(() => undefined) : Promise.resolve(page),
    );
    const { result } = renderHook(() => useSessionActivity(api, true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => {
      void result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(result.current.loaded).toBe(true);
  });

  describe('with the hub', () => {
    it('reads once, shortly after a pulse, however many come together', async () => {
      const { api, calls } = fake(async () => page);
      const { rerender } = renderHook(
        ({ kick }) => useSessionActivity(api, true, { kick, hubUp: true }),
        { initialProps: { kick: 0 } },
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(calls).toHaveLength(2);
      rerender({ kick: 1 });
      rerender({ kick: 2 });
      rerender({ kick: 3 });
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(calls).toHaveLength(4);
    });

    it('polls at the safety rate while the hub is up, and at 4 s once it is gone', async () => {
      const { api, calls } = fake(async () => page);
      const { rerender } = renderHook(
        ({ hubUp }) => useSessionActivity(api, true, { kick: 0, hubUp }),
        { initialProps: { hubUp: true } },
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0] * 3));
      expect(calls).toHaveLength(2);
      await act(() => vi.advanceTimersByTimeAsync(HUB_POLL_MS));
      expect(calls).toHaveLength(4);
      rerender({ hubUp: false });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(calls).toHaveLength(6);
      await act(() => vi.advanceTimersByTimeAsync(POLL_STEPS_MS[0] + 1));
      expect(calls).toHaveLength(8);
    });
  });
});
