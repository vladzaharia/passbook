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

  describe('prefer', () => {
    async function bodyOf() {
      const fetchMock = vi.fn(async () => Response.json({ ok: true }, { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useMagicRequest(null));
      act(() => result.current.widget.onToken('tok-1'));
      await act(async () => {
        await result.current.send('sam@example.com');
      });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    const standalone = (on: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        media: query,
        matches: on && query === '(display-mode: standalone)',
      }));
    afterEach(() => {
      delete (navigator as Navigator & { standalone?: boolean }).standalone;
    });

    it('asks for a code-first email when installed to the home screen', async () => {
      standalone(true);
      expect(await bodyOf()).toEqual({
        email: 'sam@example.com',
        turnstileToken: 'tok-1',
        prefer: 'code',
      });
    });

    it('also on iOS, where navigator.standalone says so', async () => {
      standalone(false);
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
      expect((await bodyOf()).prefer).toBe('code');
    });

    it('sends no preference in the browser', async () => {
      standalone(false);
      expect(await bodyOf()).not.toHaveProperty('prefer');
    });
  });

  it('sends no next without one, so the server picks the landing', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMagicRequest(null));
    act(() => result.current.widget.onToken('tok-1'));
    await act(async () => {
      await result.current.send('sam@example.com');
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'sam@example.com',
      turnstileToken: 'tok-1',
    });
  });
});
