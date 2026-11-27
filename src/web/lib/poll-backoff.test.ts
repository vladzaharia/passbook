import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_CAP_MS,
  backoffMs,
  holdPoll,
  pacer,
  pollEvery,
  pollPaused,
} from './poll-backoff.ts';

const limited = (retryAfter?: number) => ({ status: 429, retryAfter });

afterEach(() => {
  vi.useRealTimers();
  holdPoll('q', null);
  holdPoll('k', null);
});

describe('backoffMs', () => {
  it('is null for anything but a 429', () => {
    expect(backoffMs(1000, { status: 500 }, 1)).toBeNull();
    expect(backoffMs(1000, new Error('x'), 1)).toBeNull();
  });
  it('doubles from the poll pace and stops at 60 s', () => {
    expect([1, 2, 3].map((n) => backoffMs(4000, limited(), n))).toEqual([8000, 16_000, 32_000]);
    expect(backoffMs(4000, limited(), 9)).toBe(BACKOFF_CAP_MS);
  });
  it('honours Retry-After, never below the poll pace', () => {
    expect(backoffMs(2000, limited(17), 1)).toBe(17_000);
    expect(backoffMs(30_000, limited(5), 1)).toBe(30_000);
  });
});

describe('pacer', () => {
  it('backs off on each 429 in a row and returns to pace after a success', () => {
    const p = pacer('k', 5000);
    expect(p.after()).toBe(5000);
    expect(p.after(limited())).toBe(10_000);
    expect(p.after(limited())).toBe(20_000);
    expect(pollPaused()).toBe(true);
    expect(p.after()).toBe(5000);
    expect(pollPaused()).toBe(false);
    expect(p.after(limited())).toBe(10_000);
  });
  it('treats another error as an ordinary missed poll', () => {
    const p = pacer('k', 5000);
    expect(p.after(new Error('network'))).toBe(5000);
  });
});

describe('pollEvery', () => {
  const query = (error: unknown, errorUpdatedAt: number) => ({
    queryHash: 'q',
    state: { error, errorUpdatedAt },
  });
  it('is one stable function per pace', () => {
    expect(pollEvery(8000)).toBe(pollEvery(8000));
  });
  it('keeps the pace, backs off while the error is a 429, and resumes after a success', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const every = pollEvery(8000);
    const q = query(null, 0);
    expect(every(q)).toBe(8000);
    q.state = { error: limited(), errorUpdatedAt: 1000 };
    expect(every(q)).toBe(16_000);
    expect(every(q)).toBe(16_000);
    expect(pollPaused()).toBe(true);
    q.state = { error: limited(), errorUpdatedAt: 17_000 };
    expect(every(q)).toBe(32_000);
    q.state = { error: limited(3), errorUpdatedAt: 50_000 };
    expect(every(q)).toBe(8000);
    q.state = { error: null, errorUpdatedAt: 50_000 };
    expect(every(q)).toBe(8000);
    expect(pollPaused()).toBe(false);
    q.state = { error: limited(), errorUpdatedAt: 60_000 };
    expect(every(q)).toBe(16_000);
  });
});
