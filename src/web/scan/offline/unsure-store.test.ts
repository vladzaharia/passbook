import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../machine/fixture-data.test-support.ts';
import type { UnsureRow } from '../machine/ports.ts';
import { SCAN_TIMING } from '../timing.ts';
import { createMemoryUnsureStore, hydrateUnsure, SHIFT_MS } from './unsure-store.ts';

const row = (key: string, at: number, scannerId = 's1'): UnsureRow => ({
  entry: {
    key,
    sig: `c:${key}`,
    draft: { actionId: 'auto', amount: null },
    at,
    state: 'retrying',
  },
  scannerId,
  input: { code: key, method: 'camera' },
});

describe('memory unsure store', () => {
  it('puts, lists, removes and clears', async () => {
    const store = createMemoryUnsureStore();
    await store.put(row('a', FIXTURE_NOW));
    await store.put(row('b', FIXTURE_NOW));
    expect((await store.all()).map((r) => r.entry.key).sort()).toEqual(['a', 'b']);
    await store.remove('a');
    expect((await store.all()).map((r) => r.entry.key)).toEqual(['b']);
    await store.clear();
    expect(await store.all()).toEqual([]);
  });

  it('holds the code and the action, nothing about a holder', async () => {
    const store = createMemoryUnsureStore();
    await store.put(row('a', FIXTURE_NOW));
    const [stored] = await store.all();
    expect(Object.keys(stored ?? {}).sort()).toEqual(['entry', 'input', 'scannerId']);
    expect(Object.keys(stored?.entry ?? {}).sort()).toEqual(['at', 'draft', 'key', 'sig', 'state']);
    expect(Object.keys(stored?.input ?? {}).sort()).toEqual(['code', 'method']);
  });
});

describe('hydrateUnsure (lifecycle and expiry)', () => {
  it('keeps a recent entry retrying and expires one past the window', async () => {
    const store = createMemoryUnsureStore();
    await store.put(row('fresh', FIXTURE_NOW - 1000));
    await store.put(row('old', FIXTURE_NOW - SCAN_TIMING.UNSURE_RETRY_WINDOW - 1));
    const entries = await hydrateUnsure(store, 's1', FIXTURE_NOW);
    const by = Object.fromEntries(entries.map((e) => [e.key, e.state]));
    expect(by).toEqual({ fresh: 'retrying', old: 'expired' });
  });

  it('drops entries past the shift, and another scanner’s entries, from the store', async () => {
    const store = createMemoryUnsureStore();
    await store.put(row('stale', FIXTURE_NOW - SHIFT_MS - 1));
    await store.put(row('other', FIXTURE_NOW - 1000, 's2'));
    await store.put(row('mine', FIXTURE_NOW - 1000));
    const entries = await hydrateUnsure(store, 's1', FIXTURE_NOW);
    expect(entries.map((e) => e.key)).toEqual(['mine']);
    expect((await store.all()).map((r) => r.entry.key)).toEqual(['mine']);
  });

  it('survives a store that fails: no entries, no throw', async () => {
    const broken = {
      put: async () => {},
      remove: async () => {},
      clear: async () => {},
      all: async () => {
        throw new Error('blocked');
      },
    };
    expect(await hydrateUnsure(broken, 's1', FIXTURE_NOW)).toEqual([]);
  });
});
