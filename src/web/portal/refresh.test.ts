import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, isPendingRefresh, PENDING_TIMEOUT_MS, refreshPhase } from './refresh.ts';

const T = 1_000_000;

describe('refresh phase', () => {
  it('is idle without a request', () => {
    expect(refreshPhase({ lastRefreshedAt: null, refreshRequestedAt: null }, T).phase).toBe('idle');
  });

  it('is pending until last refresh reaches the request', () => {
    const pass = { lastRefreshedAt: T - 5000, refreshRequestedAt: T - 1000 };
    expect(isPendingRefresh(pass, T)).toBe(true);
    expect(isPendingRefresh({ ...pass, lastRefreshedAt: T - 1000 }, T)).toBe(false);
    expect(isPendingRefresh({ ...pass, lastRefreshedAt: T }, T)).toBe(false);
  });

  it('gives up on pending after the timeout', () => {
    const pass = { lastRefreshedAt: null, refreshRequestedAt: T };
    expect(isPendingRefresh(pass, T + PENDING_TIMEOUT_MS - 1)).toBe(true);
    expect(isPendingRefresh(pass, T + PENDING_TIMEOUT_MS)).toBe(false);
  });

  it('cools down after completion, counting seconds', () => {
    const pass = { lastRefreshedAt: T + 1000, refreshRequestedAt: T };
    const a = refreshPhase(pass, T + 2000);
    expect(a.phase).toBe('cooldown');
    expect(a.secondsLeft).toBe(Math.ceil((COOLDOWN_MS - 2000) / 1000));
    expect(refreshPhase(pass, T + COOLDOWN_MS).phase).toBe('idle');
  });

  it('prefers the newer local request over the server value', () => {
    const pass = { lastRefreshedAt: T, refreshRequestedAt: T - 100 };
    expect(refreshPhase(pass, T + 10).phase).toBe('cooldown');
    expect(refreshPhase(pass, T + 10, T + 5).phase).toBe('pending');
  });
});
