import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../machine/fixture-data.test-support.ts';
import { createMemoryUnsureStore } from './unsure-store.ts';
import { createMemoryKeyValue, reconcileScope, unpair, wipeLocal } from './wipe.ts';

const scope = { scannerId: 's1', mode: 'live', eventId: 'e1' } as const;

async function fill() {
  const unsure = createMemoryUnsureStore();
  await unsure.put({
    entry: {
      key: 'k',
      sig: 'c:k',
      draft: { actionId: 'auto', amount: null },
      at: FIXTURE_NOW,
      state: 'retrying',
    },
    scannerId: 's1',
    input: { code: 'k', method: 'camera' },
  });
  const queue = createMemoryKeyValue();
  const roster = createMemoryKeyValue();
  const meta = createMemoryKeyValue();
  await queue.set('q', 1);
  await roster.set('r', 1);
  return { unsure, queue, roster, meta };
}

describe('wipeLocal', () => {
  it('clears the unsure rows, the queue, the roster and the scope record', async () => {
    const stores = await fill();
    await stores.meta.set('scope', scope);
    await wipeLocal(stores);
    expect(await stores.unsure.all()).toEqual([]);
    expect(await stores.queue.all()).toEqual([]);
    expect(await stores.roster.all()).toEqual([]);
    expect(await stores.meta.get('scope')).toBeUndefined();
  });
});

describe('reconcileScope', () => {
  it('records the first scope without wiping', async () => {
    const stores = await fill();
    expect(await reconcileScope(stores, scope)).toBe(false);
    expect(await stores.unsure.all()).toHaveLength(1);
    expect(await stores.meta.get('scope')).toEqual(scope);
  });

  it('keeps everything when nothing changed', async () => {
    const stores = await fill();
    await reconcileScope(stores, scope);
    expect(await reconcileScope(stores, { ...scope })).toBe(false);
    expect(await stores.queue.all()).toHaveLength(1);
  });

  it.each([
    ['a scanner change', { ...scope, scannerId: 's2' }],
    ['a mode change', { ...scope, mode: 'test' as const }],
    ['an event change', { ...scope, eventId: 'e2' }],
  ])('wipes on %s and records the new scope', async (_name, next) => {
    const stores = await fill();
    await reconcileScope(stores, scope);
    expect(await reconcileScope(stores, next)).toBe(true);
    expect(await stores.unsure.all()).toEqual([]);
    expect(await stores.queue.all()).toEqual([]);
    expect(await stores.roster.all()).toEqual([]);
    expect(await stores.meta.get('scope')).toEqual(next);
  });
});

describe('unpair', () => {
  it('signs out, then wipes', async () => {
    const stores = await fill();
    const order: string[] = [];
    await unpair(async () => void order.push('signOut'), stores);
    expect(order).toEqual(['signOut']);
    expect(await stores.queue.all()).toEqual([]);
  });

  it('wipes even when the sign-out fails', async () => {
    const stores = await fill();
    await unpair(async () => {
      throw new Error('offline');
    }, stores);
    expect(await stores.unsure.all()).toEqual([]);
  });
});
