import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollPaused } from '../../lib/poll-hold.ts';
import { QS_TICK_MS, useSinglePoll } from './single-poll.ts';

afterEach(() => vi.useRealTimers());

const minute = (ms = 60_000) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe('useSinglePoll', () => {
  it('runs one poll at a time and stays at or under 30 calls a minute, whoever is active', async () => {
    vi.useFakeTimers();
    let running = 0;
    let overlap = 0;
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const run = (id: string) => async () => {
      running += 1;
      overlap = Math.max(overlap, running);
      calls[id] = (calls[id] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, 500));
      running -= 1;
    };
    renderHook(() => {
      useSinglePoll('a', true, run('a'));
      useSinglePoll('b', true, run('b'));
      useSinglePoll('c', false, run('c'));
    });
    await minute();
    const total = (calls.a ?? 0) + (calls.b ?? 0);
    expect(overlap).toBe(1);
    expect(total).toBeLessThanOrEqual(60_000 / QS_TICK_MS + 1);
    expect(calls.c).toBe(0);
    expect(Math.abs((calls.a ?? 0) - (calls.b ?? 0))).toBeLessThanOrEqual(1);
  });

  it('holds every poll after a 429 by Retry-After, then resumes at pace', async () => {
    vi.useFakeTimers();
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      if (n === 1) throw { status: 429, retryAfter: 20 };
    });
    renderHook(() => useSinglePoll('a', true, run));
    await minute(QS_TICK_MS + 1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pollPaused()).toBe(true);
    await minute(18_000);
    expect(run).toHaveBeenCalledTimes(1);
    await minute(2100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(pollPaused()).toBe(false);
    await minute(QS_TICK_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('doubles the wait with no Retry-After, capped at 60 s', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw { status: 429 };
    });
    renderHook(() => useSinglePoll('a', true, run));
    await minute(QS_TICK_MS + 1);
    expect(run).toHaveBeenCalledTimes(1);
    await minute(3900);
    expect(run).toHaveBeenCalledTimes(1);
    await minute(200);
    expect(run).toHaveBeenCalledTimes(2);
    await minute(10 * 60_000);
    expect(run.mock.calls.length).toBeLessThan(20);
  });

  it('stops when no poll is active', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const { unmount } = renderHook(() => useSinglePoll('a', true, run));
    await minute(QS_TICK_MS + 1);
    unmount();
    const before = run.mock.calls.length;
    await minute();
    expect(run).toHaveBeenCalledTimes(before);
    expect(pollPaused()).toBe(false);
  });
});
