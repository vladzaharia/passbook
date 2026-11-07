import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { fixtureCard, fixtureInput, states } from './fixtures.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';
import type { ScanState } from './types.ts';

const base = fixtureCard();
const card = fixtureCard({
  actions: [
    { ...base.actions[0]!, id: 'admit', kind: 'check_in', label: 'Check in', amount: null },
  ],
});
function boot(state: ScanState = states.ready()) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const store = createScanStore(fake.deps, state);
  return { ...fake, store };
}

describe('manual lookup confirmation', () => {
  it.each(['door', 'desk'] as const)(
    'one confirmation acts in %s mode without a second prompt',
    async (posture) => {
      const { store, api } = boot({ ...states.ready(), posture });
      store.checkIn(card, 'admit');
      expect(api.resolve).not.toHaveBeenCalled();
      expect(api.act).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actionId: 'admit',
          input: { passId: card.passId, method: 'manual' },
        }),
        expect.anything(),
      );
      expect(store.getSnapshot().state.loop.s).toBe('applying');
      store.checkIn(card, 'admit');
      expect(api.act).toHaveBeenCalledTimes(1);
      await flush();
      expect(store.getSnapshot().state.loop).toMatchObject({
        s: 'verdict',
        outcome: { kind: 'ok' },
      });
      store.dispose();
    },
  );

  it('an entered code follows the automatic scanner setting and armed action', async () => {
    const state = { ...states.ready(), armed: { actionId: 'admit', amount: null, sticky: true } };
    const { store, api } = boot(state);
    store.dispatch({ type: 'read', input: fixtureInput({ method: 'manual', code: '0001234' }) });
    await flush();
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.act).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionId: 'admit', input: { code: '0001234', method: 'manual' } }),
      expect.anything(),
    );
    store.dispose();
  });

  it('uses the same key and selected action when retrying an uncertain confirmation', async () => {
    const { store, api } = boot();
    api.act.mockRejectedValueOnce(new ApiError({ status: 0, code: 'network' }));
    store.checkIn(card, 'admit');
    await flush();
    const request = api.act.mock.calls[0]?.[0];
    expect(store.getSnapshot().state.unsure).toMatchObject([{ draft: { actionId: 'admit' } }]);
    store.dispatch({ type: 'online', online: true });
    await flush();
    expect(api.act.mock.calls[1]?.[0]).toEqual(request);
    store.dispose();
  });

  it('does not change the scanner’s armed action', () => {
    const armed = { actionId: 'other', amount: 5, sticky: true };
    const { store } = boot({ ...states.ready(), armed });
    store.checkIn(card, 'admit');
    expect(store.getSnapshot().state.armed).toEqual(armed);
    store.dispose();
  });

  it.each([
    states.start(),
    { ...states.ready(), block: 'revoked' as const },
    states.checking(),
    states.reviewing(),
  ])('does not act in a blocked or busy state', (state) => {
    const { store, api } = boot(state);
    store.checkIn(card, 'admit');
    expect(api.act).not.toHaveBeenCalled();
    store.dispose();
  });

  it('does not submit an unavailable or locked action, or a non-check-in action', () => {
    const { store, api } = boot();
    store.checkIn(base, base.actions[0]!.id);
    for (const action of [
      { ...card.actions[0]!, available: false },
      { ...card.actions[0]!, lock: 'approval' as const },
    ])
      store.checkIn({ ...card, actions: [action] }, action.id);
    expect(api.act).not.toHaveBeenCalled();
    store.dispose();
  });

  it('shows an offline error without submitting or inventing success', () => {
    const { store, api } = boot({ ...states.ready(), online: false });
    store.checkIn(card, 'admit');
    expect(api.act).not.toHaveBeenCalled();
    expect(store.getSnapshot().state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'system', reason: 'network' },
    });
    store.dispose();
  });
});
