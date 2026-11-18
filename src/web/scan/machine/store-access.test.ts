import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { accessBeat } from './access-events.ts';
import { grant, heldIn } from './access-fixtures.test-support.ts';
import { createDirectionPin } from './direction-pin.ts';
import { fixtureInput, states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(resetIds);

const read = (code: string) => ({
  type: 'read' as const,
  input: fixtureInput({ code, sig: `c:${code}`, id: `01900000-0000-7000-8000-0000000000${code}` }),
});

function boot() {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const pin = createDirectionPin(clock);
  const store = createScanStore({ ...fake.deps, pin }, states.ready());
  return { clock, pin, store, ...fake };
}
const sent = (api: ReturnType<typeof boot>['api'], n = 0) =>
  api.act.mock.calls[n]?.[0] as { direction?: string } | undefined;

describe('the direction a scan sends', () => {
  it('Auto sends none', async () => {
    const { store, api } = boot();
    store.dispatch(read('11'));
    expect(sent(api)).not.toHaveProperty('direction');
    await flush();
  });
  it.each(['in', 'out'] as const)('a pin of %s is sent on every scan', async (direction) => {
    const { store, api, pin } = boot();
    pin.set(direction);
    store.dispatch(read('11'));
    expect(sent(api)?.direction).toBe(direction);
    await flush();
  });
  it('a scan keeps the pin alive past the first lapse', async () => {
    const { store, pin, clock } = boot();
    pin.set('out');
    clock.advance(14 * 60_000);
    store.dispatch(read('11'));
    await flush();
    clock.advance(14 * 60_000);
    expect(pin.get()).toBe('out');
    clock.advance(2 * 60_000);
    expect(pin.get()).toBeNull();
  });
  it('a lapsed pin sends nothing', async () => {
    const { store, api, pin, clock } = boot();
    pin.set('out');
    clock.advance(15 * 60_000);
    store.dispatch(read('11'));
    expect(sent(api)).not.toHaveProperty('direction');
    await flush();
  });
  it('Tap out names the direction even over an In pin', async () => {
    const { store, api, pin } = boot();
    pin.set('in');
    api.act.mockResolvedValueOnce(heldIn());
    store.dispatch(read('11'));
    await flush();
    store.dispatch({ type: 'turn', direction: 'out' });
    expect(sent(api, 1)?.direction).toBe('out');
    expect(api.act.mock.calls[1]?.[0]).not.toHaveProperty('overrideOf');
  });
});

describe('the buddy', () => {
  it('a grant plays gate after the usual 150 ms', async () => {
    const { store, api, clock } = boot();
    api.act.mockResolvedValueOnce(grant());
    store.dispatch(read('11'));
    await flush();
    expect(store.getSnapshot().view.buddy.beat).not.toBe(accessBeat('gate'));
    clock.advance(SCAN_TIMING.BEAT_DELAY);
    expect(store.getSnapshot().view.buddy.beat).toBe(accessBeat('gate'));
  });
  it('relent starts at once: its first 150 ms is the oh', async () => {
    const { store, api } = boot();
    const refused = heldIn();
    refused.scanId = 'scan-refused';
    api.act.mockResolvedValueOnce(refused);
    store.dispatch(read('11'));
    await flush();
    store.dispatch({
      type: 'resolved',
      of: 'scan-refused',
      outcome: grant(),
      by: { staff: 'Sam K.', device: 'Office iPad' },
    });
    expect(store.getSnapshot().view.buddy.beat).toBe(accessBeat('relent'));
  });
});
