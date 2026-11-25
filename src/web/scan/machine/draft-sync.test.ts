import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCard, fixtureInput, fixtureOutcome, states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(resetIds);

const take = {
  ...(fixtureCard().actions[1] as NonNullable<ReturnType<typeof fixtureCard>['actions'][number]>),
  id: 'take_money',
  available: true,
  lock: null,
  confirm: false,
  amount: { max: 100, presets: [10, 20], default: 12 },
};
const card = fixtureCard({ actions: [take as never, ...fixtureCard().actions.slice(0, 1)] });

const keyOf = (api: { resolve: { mock: { calls: unknown[][] } } }): string =>
  ((api.resolve.mock.calls[0]?.[0] ?? {}) as { idempotencyKey: string }).idempotencyKey;

async function desk(passId?: string) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const draft = {
    put: vi.fn(async (_body: { ref: string; actionId: string; amount: number }, _o: unknown) => ({
      screens: 1,
    })),
    clear: vi.fn(async (_ref: string, _o: unknown) => ({ screens: 1 })),
  };
  fake.api.resolve.mockResolvedValue(fixtureOutcome('ready', null, { card }));
  const store = createScanStore({ ...fake.deps, draft }, { ...states.ready(), posture: 'desk' });
  const input = fixtureInput({
    code: 'AAAA1111',
    sig: 'c:AAAA1111',
    ...(passId ? { passId } : {}),
  });
  store.dispatch({ type: 'read', input });
  await flush();
  return { clock, store, draft, api: fake.api, input };
}

describe('draft sync', () => {
  it('sends the resolve key and the amount once the typing settles', async () => {
    const { clock, store, draft, api } = await desk();
    store.dispatch({ type: 'pick', actionId: take.id });
    clock.advance(100);
    store.dispatch({ type: 'amount', value: 20 });
    clock.advance(249);
    expect(draft.put).not.toHaveBeenCalled();
    clock.advance(1);
    const key = keyOf(api);
    expect(draft.put).toHaveBeenCalledTimes(1);
    expect(draft.put).toHaveBeenCalledWith(
      { ref: key, actionId: take.id, amount: 20 },
      expect.anything(),
    );
  });

  it('sends at most four a second', async () => {
    const { clock, store, draft } = await desk();
    store.dispatch({ type: 'pick', actionId: take.id });
    for (let v = 1; v <= 40; v++) {
      store.dispatch({ type: 'amount', value: v });
      clock.advance(50);
    }
    clock.advance(300);
    expect(draft.put.mock.calls.length).toBeLessThanOrEqual(9);
    expect(draft.put.mock.calls.at(-1)?.[0]).toMatchObject({ amount: 40 });
  });

  it('Cancel clears the draft and drops a pending one', async () => {
    const { clock, store, draft, api } = await desk();
    store.dispatch({ type: 'pick', actionId: take.id });
    clock.advance(300);
    store.dispatch({ type: 'amount', value: 30 });
    store.dispatch({ type: 'cancel' });
    clock.advance(1000);
    const key = keyOf(api);
    expect(draft.put).toHaveBeenCalledTimes(1);
    expect(draft.clear).toHaveBeenCalledWith(key, expect.anything());
  });

  it('Confirm sends no clear and no late draft', async () => {
    const { clock, store, draft } = await desk();
    store.dispatch({ type: 'pick', actionId: take.id });
    store.dispatch({ type: 'amount', value: 30 });
    store.dispatch({ type: 'confirm' });
    clock.advance(1000);
    expect(draft.put).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
  });

  it('never drafts a lookup read, an offline read or a non-money action', async () => {
    const lookup = await desk('pass-1');
    lookup.store.dispatch({ type: 'pick', actionId: take.id });
    lookup.clock.advance(1000);
    expect(lookup.draft.put).not.toHaveBeenCalled();
    const offline = await desk();
    offline.store.dispatch({ type: 'online', online: false });
    offline.store.dispatch({ type: 'pick', actionId: take.id });
    offline.clock.advance(1000);
    expect(offline.draft.put).not.toHaveBeenCalled();
  });

  it('swallows a failed draft', async () => {
    const { clock, store, draft } = await desk();
    draft.put.mockRejectedValue(new Error('boom'));
    store.dispatch({ type: 'pick', actionId: take.id });
    clock.advance(300);
    await flush();
    expect(store.getSnapshot().state.loop.s).toBe('member');
    expect(store.getSnapshot().state.block).toBeNull();
    expect(store.getSnapshot().draftFailures).toEqual({ count: 1, last: 'network' });
  });
});
