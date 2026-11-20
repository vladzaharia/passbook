import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBudget } from './budget.ts';
import { fakeNetwork, json } from './test-support.ts';
import { onSignedOut, REFRESH_MS, resetToken, retain, token } from './token.ts';

beforeEach(() => {
  vi.useFakeTimers();
  resetToken();
  resetBudget();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('try token lifetime', () => {
  it('refreshes at 12 minutes, not before', async () => {
    const net = fakeNetwork(() => json({}));
    await token('c');
    await token('c');
    expect(net.mints()).toBe(1);
    vi.advanceTimersByTime(REFRESH_MS - 1000);
    await token('c');
    expect(net.mints()).toBe(1);
    vi.advanceTimersByTime(2000);
    await token('c');
    expect(net.mints()).toBe(2);
    expect(REFRESH_MS).toBe(12 * 60_000);
  });

  it('shares one mint between callers that ask together', async () => {
    const net = fakeNetwork(() => json({}));
    await Promise.all([token('c'), token('c'), token('c')]);
    expect(net.mints()).toBe(1);
  });

  it('mints again on its own while a console is open, and stops when the last one closes', async () => {
    const net = fakeNetwork(() => json({}));
    await token('c');
    const release = retain('c');
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
    expect(net.mints()).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(net.mints()).toBe(2);
  });

  it('sends the mint the CSRF token and nothing else, and keeps no copy outside the module', async () => {
    const net = fakeNetwork(() => json({}));
    await token('csrf-9');
    const mint = net.calls[0];
    expect(mint?.method).toBe('POST');
    expect(mint?.headers['x-csrf-token']).toBe('csrf-9');
    expect(mint?.body).toBeUndefined();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('stops asking and says so once when the session is gone', async () => {
    const gone = vi.fn();
    const off = onSignedOut(gone);
    let mints = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        mints += 1;
        return mints === 1
          ? Response.json({ token: 'pbtry_x.y' }, { status: 201 })
          : Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
      }),
    );
    await token('c');
    retain('c');
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
    expect(gone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(mints).toBe(2);
    off();
  });
});
