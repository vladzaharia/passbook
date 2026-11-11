import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './api.ts';
import {
  getMode,
  MODE_KEY,
  modeHeaders,
  onModeChange,
  resetModeForTests,
  setMode,
} from './mode.ts';
import { createQueryClient } from './query-client.ts';
import { json, sessionFixture } from './test-utils.tsx';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('mode store', () => {
  it('starts live and keeps Test mode in storage', () => {
    expect(getMode()).toBe('live');
    expect(modeHeaders()).toEqual({});
    setMode('test');
    expect(getMode()).toBe('test');
    expect(localStorage.getItem(MODE_KEY)).toBe('test');
    expect(modeHeaders()).toEqual({ 'x-passbook-mode': 'test' });
    setMode('live');
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
  });

  it('survives blocked storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    expect(() => setMode('test')).not.toThrow();
    expect(getMode()).toBe('test');
    expect(() => resetModeForTests()).not.toThrow();
  });

  it('tells listeners once per change, and follows another tab', () => {
    const seen: string[] = [];
    const off = onModeChange((m) => seen.push(m));
    setMode('test');
    setMode('test');
    localStorage.removeItem(MODE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: MODE_KEY }));
    off();
    setMode('test');
    expect(seen).toEqual(['test', 'live']);
  });
});

describe('the API client', () => {
  const Any = z.object({ ok: z.boolean() });
  const run = async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const api = createApiClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      getCsrfToken: async () => 'tok',
    });
    await api.get('/api/v1/passes', Any);
    await api.post('/api/v1/passes', Any, {});
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    return calls.map(([, init]) => (init.headers as Record<string, string>)['x-passbook-mode']);
  };

  it('sends x-passbook-mode: test on every request while Test mode is on', async () => {
    setMode('test');
    expect(await run()).toEqual(['test', 'test']);
  });

  it('sends nothing in live mode', async () => {
    expect(await run()).toEqual([undefined, undefined]);
  });
});

describe('switching mode', () => {
  it('empties the cache of the other mode but keeps the session', async () => {
    const client = createQueryClient();
    client.setQueryData(['passes', 'list'], { items: ['live pass'] });
    const session = sessionFixture('admin');
    client.setQueryData(['session'], session);
    setMode('test');
    await Promise.resolve();
    expect(client.getQueryData(['passes', 'list'])).toBeUndefined();
    expect(client.getQueryData(['session'])).toEqual(session);
    client.setQueryData(['passes', 'list'], { items: ['test pass'] });
    setMode('live');
    await Promise.resolve();
    expect(client.getQueryData(['passes', 'list'])).toBeUndefined();
  });
});
