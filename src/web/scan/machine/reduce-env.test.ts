import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { nextDeadline } from './deadlines.ts';
import { fixtureState, states } from './fixtures.test-support.ts';
import { at, readOf, resetIds, step } from './reduce.test-support.ts';

beforeEach(resetIds);

describe('start, camera and focus', () => {
  it('start runs the gesture commands in one reduction', () => {
    const r = step(states.start(), { type: 'start' });
    expect(r.state.started).toBe(true);
    expect(r.cmds).toEqual([
      { c: 'audio', op: 'unlock' },
      { c: 'wake', op: 'request' },
      { c: 'camera', op: 'start' },
    ]);
  });

  it('start skips the camera on a reader-only scanner', () => {
    const r = step(fixtureState({ started: false, camera: 'disabled' }), { type: 'start' });
    expect(r.cmds).toEqual([
      { c: 'audio', op: 'unlock' },
      { c: 'wake', op: 'request' },
    ]);
  });

  it('camera live resets the hint clock; blocked moves focus to the code field and wedge reads still check', () => {
    const live = step(
      fixtureState({ camera: 'starting' }),
      { type: 'camera', status: 'live' },
      at(500),
    );
    expect(live.state.loop).toMatchObject({ s: 'ready', since: at(500), hint: 0 });
    const blocked = step(states.ready(), { type: 'camera', status: 'blocked' });
    expect(blocked.cmds).toContainEqual({ c: 'focus', target: 'enter-code' });
    const read = step(blocked.state, readOf('AAAA1111', { method: 'wedge' }));
    expect(read.state.loop.s).toBe('checking');
  });

  it('prefs, counts, queue, overlay, scope and online update the state', () => {
    let s = states.ready();
    s = step(s, { type: 'prefs', prefs: { sound: false } }).state;
    s = step(s, { type: 'online', online: false }).state;
    s = step(s, { type: 'overlay', open: 'lookup' }).state;
    s = step(s, { type: 'scope', scope: { direction: 'out' } }).state;
    s = step(s, { type: 'queue', pending: 2, oldestAt: at(1), conflicts: 0 }).state;
    expect(s).toMatchObject({
      prefs: { sound: false },
      online: false,
      overlay: 'lookup',
      scope: { direction: 'out' },
      queue: { pending: 2 },
    });
  });

  it('a reading while an overlay is open still runs', () => {
    const s = fixtureState({ overlay: 'lookup' });
    expect(step(s, readOf('AAAA1111')).state.loop.s).toBe('checking');
  });
});

describe('visibility and idle', () => {
  it('resumes a reader-only scanner without starting its disabled camera', () => {
    const hidden = step(fixtureState({ camera: 'disabled' }), { type: 'visible', visible: false });
    const resumed = step(hidden.state, { type: 'resume' });
    expect(resumed.state.camera).toBe('disabled');
    expect(resumed.cmds.some((cmd) => cmd.c === 'camera')).toBe(false);
  });

  it('hidden pauses; visible keeps it paused; resume restarts', () => {
    const hidden = step(states.ready(), { type: 'visible', visible: false });
    expect(hidden.state.loop).toEqual({ s: 'paused', reason: 'hidden' });
    expect(hidden.cmds).toContainEqual({ c: 'camera', op: 'pause' });
    expect(hidden.cmds).toContainEqual({ c: 'beat', beat: 'cut' });
    const shown = step(hidden.state, { type: 'visible', visible: true });
    expect(shown.state.loop.s).toBe('paused');
    const resumed = step(shown.state, { type: 'resume' });
    expect(resumed.state.loop.s).toBe('ready');
    expect(resumed.cmds).toEqual([
      { c: 'wake', op: 'request' },
      { c: 'audio', op: 'unlock' },
      { c: 'camera', op: 'resume' },
    ]);
  });

  it('handheld pauses at 60 s and stops the stream 5 min later', () => {
    const s = states.ready();
    expect(nextDeadline(s, at(0))).toBe(at(SCAN_TIMING.HINT_AFTER));
    const idle = step(s, { type: 'tick' }, at(SCAN_TIMING.IDLE_PAUSE));
    expect(idle.state.loop).toEqual({ s: 'paused', reason: 'idle' });
    expect(idle.cmds).toContainEqual({ c: 'camera', op: 'pause' });
    const stopped = step(
      idle.state,
      { type: 'tick' },
      at(SCAN_TIMING.IDLE_PAUSE + SCAN_TIMING.STREAM_RELEASE),
    );
    expect(stopped.cmds).toEqual([{ c: 'camera', op: 'stop' }]);
    const resumed = step(
      { ...stopped.state, camera: 'off' },
      { type: 'resume' },
      at(SCAN_TIMING.IDLE_PAUSE + SCAN_TIMING.STREAM_RELEASE + 10),
    );
    expect(resumed.cmds).toContainEqual({ c: 'camera', op: 'start' });
  });

  it('a stand slows down once and never pauses', () => {
    const s = fixtureState({ layout: 'stand' });
    const slow = step(s, { type: 'tick' }, at(SCAN_TIMING.IDLE_PAUSE));
    expect(slow.state.loop.s).toBe('ready');
    expect(slow.cmds).toEqual([{ c: 'camera', op: 'slow' }]);
    expect(nextDeadline(slow.state, at(SCAN_TIMING.IDLE_PAUSE))).toBeNull();
  });

  it('hints step at 4, 8 and 12 s while activity is recent', () => {
    let s = fixtureState({ lastActivity: at(0) });
    for (const [ms, hint] of [
      [4000, 1],
      [8000, 2],
      [12_000, 3],
    ] as const) {
      s = step(s, { type: 'tick' }, at(ms)).state;
      expect(s.loop).toMatchObject({ s: 'ready', hint });
    }
    expect(nextDeadline(s, at(12_000))).not.toBe(at(16_000));
  });

  it('member card clears at 60 s idle, and holdResults turns that off', () => {
    const s = states.member();
    expect(nextDeadline(s, at(1))).toBe(at(SCAN_TIMING.CARD_IDLE_CLEAR));
    const cleared = step(s, { type: 'tick' }, at(SCAN_TIMING.CARD_IDLE_CLEAR));
    expect(cleared.state.loop.s).toBe('ready');
    expect(cleared.cmds).toContainEqual({ c: 'card.tuck' });
    const held = fixtureState({ ...s, prefs: { holdResults: true, sound: true } });
    expect(nextDeadline(held, at(1))).toBeNull();
  });

  it('card phases advance on their durations', () => {
    const rising = { ...states.cardPhase('rising'), cardAt: at(0) };
    expect(nextDeadline(rising, at(1))).toBe(at(SCAN_TIMING.CARD_RISE));
    expect(step(rising, { type: 'tick' }, at(SCAN_TIMING.CARD_RISE)).state.card?.phase).toBe('up');
    const tucking = { ...states.cardPhase('tucking'), cardAt: at(0) };
    expect(step(tucking, { type: 'tick' }, at(SCAN_TIMING.CARD_TUCK)).state.card).toBeNull();
  });
});

describe('reader', () => {
  it('a wedge or nfc read stamps reader.lastAt; the reader event patches the state', () => {
    const wedge = step(states.ready(), readOf('AAAA1111', { method: 'wedge' }), at(500));
    expect(wedge.state.reader.lastAt).toBe(at(500));
    const camera = step(states.ready(), readOf('AAAA1111'), at(500));
    expect(camera.state.reader.lastAt).toBeNull();
    const patched = step(states.ready(), { type: 'reader', reader: { kind: 'nfc', badLayout: 3 } });
    expect(patched.state.reader).toMatchObject({ kind: 'nfc', badLayout: 3 });
  });
});
