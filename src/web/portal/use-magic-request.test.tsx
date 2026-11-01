import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_WAIT_MS, useMagicRequest } from './use-magic-request.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useMagicRequest', () => {
  it('gives up after waiting 10 s for the challenge', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMagicRequest('/'));
    let outcome: unknown;
    act(() => {
      void result.current.send('sam@example.com').then((r) => {
        outcome = r;
      });
    });
    expect(result.current.phase).toBe('checking');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHALLENGE_WAIT_MS);
    });
    expect(outcome).toEqual({ ok: false, challenge: true });
    expect(result.current.phase).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses each token once and asks for a fresh challenge', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMagicRequest('/next'));
    const before = result.current.widget.resetKey;
    act(() => result.current.widget.onToken('tok-1'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send('sam@example.com');
    });
    expect(outcome).toEqual({ ok: true });
    expect(result.current.widget.resetKey).toBe(before + 1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'sam@example.com',
      turnstileToken: 'tok-1',
      next: '/next',
    });
  });
});
