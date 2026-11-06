import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureInput, fixtureOutcome, states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(resetIds);

const read = (code: string, at: number) => ({
  type: 'read' as const,
  input: fixtureInput({
    code,
    sig: `c:${code}`,
    id: `01900000-0000-7000-8000-00000000${code.length}${code}`.slice(0, 36),
    at,
  }),
});

const keyOfCall = (call: readonly unknown[] | undefined): string =>
  ((call?.[0] ?? {}) as { idempotencyKey: string }).idempotencyKey;

function boot(state = states.ready()) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const store = createScanStore(fake.deps, state);
  return { clock, store, ...fake };
}

describe('scan store', () => {
  it('a read becomes an act request and its answer a verdict', async () => {
    const { store, api, calls } = boot();
    store.dispatch(read('AAAA1111', 0));
    expect(calls).toContain('camera.pause');
    expect(api.act).toHaveBeenCalledTimes(1);
    const body = api.act.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      input: { code: 'AAAA1111', method: 'camera' },
      actionId: 'auto',
      dayStart: expect.any(Number),
    });
    expect(store.getSnapshot().state.loop.s).toBe('checking');
    await flush();
    const snap = store.getSnapshot();
    expect(snap.state.loop).toMatchObject({ s: 'verdict', outcome: { kind: 'ok' } });
    expect(snap.view.tint).toBe('green');
    expect(calls).toContain('sound.ok');
  });

  it('the result beat starts BEAT_DELAY after the verdict; the lock beat is immediate', async () => {
    const { store, clock } = boot();
    store.dispatch(read('AAAA1111', 0));
    expect(store.getSnapshot().view.buddy.beat).toBe('lock');
    await flush();
    expect(store.getSnapshot().view.buddy.beat).toBe('lock');
    clock.advance(SCAN_TIMING.BEAT_DELAY);
    expect(store.getSnapshot().view.buddy.beat).toBe('sparkle');
    const key = store.getSnapshot().view.buddy.key;
    store.dispatch({
      type: 'read',
      input: fixtureInput({ code: 'B', sig: 'c:B', id: '01900000-0000-7000-8000-0000000000bb' }),
    });
    clock.advance(SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT);
    expect(store.getSnapshot().view.buddy.key).not.toBe(key);
  });

  it('notifies subscribers and rearms the deadline timer: ok closes after the hold', async () => {
    const { store, clock } = boot();
    let n = 0;
    store.subscribe(() => n++);
    store.dispatch(read('AAAA1111', 0));
    await flush();
    expect(n).toBeGreaterThan(0);
    clock.advance(SCAN_TIMING.OK_HOLD + 10);
    expect(store.getSnapshot().state.loop.s).toBe('ready');
  });

  it('a request with no answer times out at 5 s, becomes unsure, is kept and retried with the same key', async () => {
    const { store, clock, api, unsure } = boot();
    api.act.mockImplementationOnce(() => new Promise(() => {}));
    store.dispatch(read('AAAA1111', 0));
    const firstKey = keyOfCall(api.act.mock.calls[0]);
    clock.advance(SCAN_TIMING.LOOKUP_TIMEOUT);
    const s = store.getSnapshot().state;
    expect(s.loop).toMatchObject({ outcome: { reason: 'unconfirmed' } });
    expect(s.unsure).toHaveLength(1);
    expect([...unsure.rows.values()][0]?.input).toEqual({ code: 'AAAA1111', method: 'camera' });
    // the row holds the code and the action, nothing about the holder
    expect(JSON.stringify([...unsure.rows.values()][0])).not.toMatch(/Anna|email|title/);
    clock.advance(SCAN_TIMING.UNSURE_RETRY_EVERY);
    await flush();
    expect(api.act).toHaveBeenCalledTimes(2);
    expect(keyOfCall(api.act.mock.calls[1])).toBe(firstKey);
    // the retry's answer replaces the verdict on screen and clears the entry
    expect(store.getSnapshot().state.loop).toMatchObject({ outcome: { kind: 'ok' } });
    expect(store.getSnapshot().state.unsure).toEqual([]);
    expect(unsure.rows.size).toBe(0);
  });

  it('a network error at the door is unsure at once; coming online retries', async () => {
    const { store, api } = boot();
    api.act.mockRejectedValueOnce(new ApiError({ status: 0, code: 'network' }));
    store.dispatch(read('AAAA1111', 0));
    await flush();
    expect(store.getSnapshot().state.unsure).toHaveLength(1);
    store.dispatch({ type: 'online', online: true });
    await flush();
    expect(api.act).toHaveBeenCalledTimes(2);
  });

  it('does not play sounds when the preference is off', async () => {
    const { store, calls } = boot();
    store.dispatch({ type: 'prefs', prefs: { sound: false } });
    store.dispatch(read('AAAA1111', 0));
    await flush();
    expect(calls.some((c) => c.startsWith('sound.'))).toBe(false);
  });

  it('revoked wipes local data once', async () => {
    const { store, api, deps, unsure } = boot();
    unsure.rows.set('k', { entry: {} as never, scannerId: 's', input: { method: 'camera' } });
    api.act.mockRejectedValueOnce(new ApiError({ status: 401, code: 'SCANNER_REVOKED' }));
    deps.toFail = () => ({ error: 'revoked' });
    store.dispatch(read('AAAA1111', 0));
    await flush();
    expect(store.getSnapshot().state.block).toBe('revoked');
    expect(deps.wipe).toHaveBeenCalledTimes(1);
    expect(unsure.rows.size).toBe(0);
  });

  it('the Start tap runs the gesture ports synchronously', () => {
    const { store, calls } = boot(states.start());
    store.dispatch({ type: 'start' });
    expect(calls).toEqual(['audio.unlock', 'wake.request', 'camera.start']);
  });

  it('a desk read sends resolve and opens the member panel', async () => {
    const { store, api } = boot({ ...states.ready(), posture: 'desk' });
    store.dispatch(read('AAAA1111', 0));
    await flush();
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state.loop.s).toBe('member');
    expect(fixtureOutcome('ready').kind).toBe('ready');
  });

  it('dispose stops the timers', async () => {
    const { store, clock } = boot();
    store.dispatch(read('AAAA1111', 0));
    await flush();
    store.dispose();
    clock.advance(60_000);
    expect(store.getSnapshot().state.loop.s).toBe('verdict');
  });
});
