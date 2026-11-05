import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureCard, fixtureOutcome, fixtureState, states } from './fixtures.test-support.ts';
import {
  answerOf,
  at,
  cmdsOf,
  hasCmd,
  readOf,
  requestKey,
  resetIds,
  step,
} from './reduce.test-support.ts';
import type { ScanState } from './types.ts';

beforeEach(resetIds);

/** Reads AAAA1111 and returns the checking state plus its request key. */
function sent(state: ScanState = states.ready()) {
  const r = step(state, readOf('AAAA1111'));
  return { state: r.state, key: requestKey(r.cmds) };
}

describe('answer', () => {
  it('ok enters a verdict with a rising card, the tone, the beat and counts', () => {
    const { state, key } = sent();
    const r = step(state, answerOf(key), at(100));
    expect(r.state.loop).toMatchObject({
      s: 'verdict',
      closeAt: at(100 + SCAN_TIMING.OK_HOLD),
      settleAt: null,
      openFrom: at(100 + SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT),
    });
    expect(r.state.card).toMatchObject({ phase: 'rising', kind: 'result' });
    expect(r.cmds.map((c) => c.c)).toEqual(['camera', 'sound', 'card.rise', 'beat', 'announce']);
    expect(cmdsOf(r.cmds, 'sound')[0]).toEqual({ c: 'sound', tone: 'ok' });
    expect(r.state.counts?.today).toBe(42);
    expect(r.state.recent).toHaveLength(1);
    expect(r.state.ignore[0]).toMatchObject({
      sig: 'c:AAAA1111',
      why: 'accepted',
      until: at(5100),
    });
  });

  it('a milestone adds celebrate and the reward tone', () => {
    const { state, key } = sent();
    const r = step(state, answerOf(key, 'ok', null, { milestone: 'reward' }), at(100));
    expect(r.cmds).toContainEqual({ c: 'sound', tone: 'reward' });
    expect(r.cmds).toContainEqual({ c: 'celebrate' });
  });

  it('a stale key does nothing', () => {
    const { state } = sent();
    const r = step(state, answerOf('01900000-0000-7000-8000-00000000ffff'), at(100));
    expect(r.state).toBe(state);
    expect(r.cmds).toEqual([]);
  });

  it('heads_up never times out and focuses Done; its code is shown, then ignored 5 s on dismiss', () => {
    const { state, key } = sent();
    const v = step(state, answerOf(key, 'heads_up', 'already_done'), at(100));
    expect(v.state.loop).toMatchObject({ s: 'verdict', closeAt: null, settleAt: null });
    expect(v.cmds).toContainEqual({ c: 'focus', target: 'done' });
    const later = step(v.state, { type: 'tick' }, at(100 + 600_000));
    expect(later.state.loop.s).toBe('verdict');
    const closed = step(v.state, { type: 'dismiss' }, at(1000));
    expect(closed.state.loop.s).toBe('ready');
    expect(closed.state.ignore[0]).toMatchObject({ sig: 'c:AAAA1111', until: at(6000) });
    expect(closed.cmds).toContainEqual({ c: 'card.tuck' });
  });

  it('refused holds 3 s at the door; ambiguous holds until a tap', () => {
    const a = sent();
    const refused = step(a.state, answerOf(a.key, 'refused', 'voided'), at(100));
    expect(refused.state.loop).toMatchObject({ closeAt: at(100 + SCAN_TIMING.REFUSED_HOLD) });
    const b = sent();
    const amb = step(b.state, answerOf(b.key, 'refused', 'ambiguous'), at(100));
    expect(amb.state.loop).toMatchObject({ closeAt: null });
  });

  it('holdResults holds every verdict', () => {
    const s = fixtureState({ prefs: { holdResults: true, sound: true } });
    const { state, key } = sent(s);
    const r = step(state, answerOf(key), at(100));
    expect(r.state.loop).toMatchObject({ closeAt: null, settleAt: null });
  });

  it('rate_limited closes at Retry-After', () => {
    const { state, key } = sent();
    const r = step(
      state,
      { type: 'fail', key, error: 'rate_limited', retryAfterMs: 7000 },
      at(100),
    );
    expect(r.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'system', reason: 'rate_limited' },
      closeAt: at(7100),
    });
    expect(r.state.ignore).toEqual([]);
  });

  it('close with no next enters ready and tucks; with next enters checking with the card still up', () => {
    const { state, key } = sent();
    const v = step(state, answerOf(key), at(100));
    const closed = step(v.state, { type: 'tick' }, at(100 + SCAN_TIMING.OK_HOLD));
    expect(closed.state.loop.s).toBe('ready');
    expect(closed.state.card?.phase).toBe('tucking');
    const early = step(v.state, readOf('BBBB2222'), at(300));
    const closedNext = step(
      early.state,
      { type: 'tick' },
      at(100 + SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT),
    );
    expect(closedNext.state.loop.s).toBe('checking');
    expect(closedNext.state.card).not.toBeNull();
    expect(hasCmd(closedNext.cmds, 'act')).toBe(true);
  });

  it('a verdict mid-rise swaps once; a desk ready answer opens the member panel', () => {
    const first = sent();
    const v1 = step(first.state, answerOf(first.key), at(100));
    const second = step(v1.state, readOf('BBBB2222'), at(100 + 350));
    const key2 = requestKey(second.cmds);
    const v2 = step(second.state, answerOf(key2, 'refused', 'voided'), at(100 + 400));
    expect(cmdsOf(v2.cmds, 'card.swap')).toHaveLength(1);
    expect(hasCmd(v2.cmds, 'card.rise')).toBe(false);

    const desk = fixtureState({ posture: 'desk' });
    const d = step(desk, readOf('AAAA1111'));
    const ready = step(
      d.state,
      { type: 'answer', key: requestKey(d.cmds), outcome: fixtureOutcome('ready') },
      at(100),
    );
    expect(ready.state.loop).toMatchObject({ s: 'member', band: null });
    expect(ready.state.card).toMatchObject({ kind: 'panel', phase: 'rising' });
    expect(ready.cmds).toContainEqual({ c: 'beat', beat: 'look' });
    expect(cmdsOf(ready.cmds, 'announce')[0]).toMatchObject({ polite: true });
  });

  it('a desk ok settles into the member band at OK_HOLD', () => {
    const desk = fixtureState({ posture: 'desk' });
    const d = step(desk, readOf('AAAA1111'));
    const key = requestKey(d.cmds);
    const v = step(d.state, answerOf(key, 'ok', null, { card: fixtureCard() }), at(100));
    expect(v.state.loop).toMatchObject({
      s: 'verdict',
      settleAt: at(100 + SCAN_TIMING.OK_HOLD),
      closeAt: null,
    });
    const settled = step(v.state, { type: 'tick' }, at(100 + SCAN_TIMING.OK_HOLD));
    expect(settled.state.loop).toMatchObject({ s: 'member', band: { kind: 'ok' } });
  });

  it('a one-shot armed action is cleared by an ok, a sticky one stays', () => {
    const once = fixtureState({ armed: { actionId: 'add_stamp', amount: 1, sticky: false } });
    const a = sent(once);
    expect(step(a.state, answerOf(a.key), at(100)).state.armed).toBeNull();
    const sticky = fixtureState({ armed: { actionId: 'add_stamp', amount: 1, sticky: true } });
    const b = sent(sticky);
    expect(step(b.state, answerOf(b.key), at(100)).state.armed).not.toBeNull();
  });
});

describe('fail', () => {
  it('door network failure keeps an unsure entry and shows unconfirmed', () => {
    const { state, key } = sent();
    const r = step(state, { type: 'fail', key, error: 'network' }, at(100));
    expect(r.state.loop).toMatchObject({ outcome: { kind: 'system', reason: 'unconfirmed' } });
    expect(r.state.unsure).toHaveLength(1);
    expect(r.state.unsure[0]).toMatchObject({ key, sig: 'c:AAAA1111', state: 'retrying' });
    expect(cmdsOf(r.cmds, 'unsure.keep')).toHaveLength(1);
    expect(r.state.recent[0]?.outcome.reason).toBe('unconfirmed');
  });

  it('desk resolve failure keeps no unsure entry', () => {
    const d = step(fixtureState({ posture: 'desk' }), readOf('AAAA1111'));
    const r = step(d.state, { type: 'fail', key: requestKey(d.cmds), error: 'timeout' }, at(100));
    expect(r.state.loop).toMatchObject({ outcome: { reason: 'timeout' } });
    expect(r.state.unsure).toEqual([]);
    expect(hasCmd(r.cmds, 'unsure.keep')).toBe(false);
  });

  it('a re-read inside 2 min reuses the key; after 2 min it gets a new one', () => {
    const { state, key } = sent();
    const failed = step(state, { type: 'fail', key, error: 'network' }, at(100));
    const closed = step(failed.state, { type: 'dismiss' }, at(200));
    const reuse = step(
      closed.state,
      readOf('AAAA1111'),
      at(100 + SCAN_TIMING.UNSURE_RETRY_WINDOW - 1),
    );
    expect(requestKey(reuse.cmds)).toBe(key);
    const fresh = step(closed.state, readOf('AAAA1111'), at(100 + SCAN_TIMING.UNSURE_RETRY_WINDOW));
    expect(requestKey(fresh.cmds)).not.toBe(key);
  });

  it('unsure expires after the window, updates the recent row and locks the open card', () => {
    const { state, key } = sent();
    const failed = step(state, { type: 'fail', key, error: 'network' }, at(100));
    const expired = step(failed.state, { type: 'tick' }, at(100 + SCAN_TIMING.UNSURE_RETRY_WINDOW));
    expect(expired.state.unsure[0]?.state).toBe('expired');
    expect(expired.state.recent[0]?.outcome.reason).toBe('still_unconfirmed');
  });

  it('a late answer on screen replaces the verdict; off screen it updates the recent row', () => {
    const { state, key } = sent();
    const failed = step(state, { type: 'fail', key, error: 'network' }, at(100));
    const onScreen = step(failed.state, answerOf(key, 'ok'), at(2000));
    expect(onScreen.state.loop).toMatchObject({ s: 'verdict', outcome: { kind: 'ok' } });
    expect(onScreen.state.unsure).toEqual([]);
    expect(cmdsOf(onScreen.cmds, 'unsure.drop')).toHaveLength(1);
    expect(onScreen.state.recent).toHaveLength(1);
    expect(onScreen.state.recent[0]?.outcome.kind).toBe('ok');

    const away = step(failed.state, { type: 'dismiss' }, at(200));
    const off = step(away.state, answerOf(key, 'ok'), at(3000));
    expect(off.state.loop.s).toBe('ready');
    expect(off.state.recent[0]?.outcome.kind).toBe('ok');
    expect(cmdsOf(off.cmds, 'announce')[0]).toMatchObject({ polite: true });
  });

  it('fail on an unsure retry is ignored', () => {
    const { state, key } = sent();
    const failed = step(state, { type: 'fail', key, error: 'network' }, at(100));
    const again = step(failed.state, { type: 'fail', key, error: 'network' }, at(5000));
    expect(again.state).toBe(failed.state);
  });

  it('server and forbidden map to a system and a refused verdict', () => {
    const a = sent();
    const server = step(
      a.state,
      { type: 'fail', key: a.key, error: 'server', requestId: 'r1' },
      at(10),
    );
    expect(server.state.loop).toMatchObject({
      outcome: { kind: 'system', reason: 'server', requestId: 'r1' },
    });
    const b = sent();
    const forbidden = step(b.state, { type: 'fail', key: b.key, error: 'forbidden' }, at(10));
    expect(forbidden.state.loop).toMatchObject({ outcome: { kind: 'refused' } });
  });

  it('revoked, suspended and signed_out set block, stop the camera and release the wake lock', () => {
    for (const error of ['revoked', 'suspended', 'signed_out'] as const) {
      const { state, key } = sent();
      const r = step(state, { type: 'fail', key, error }, at(10));
      expect(r.state.block).toBe(error);
      expect(r.cmds).toContainEqual({ c: 'camera', op: 'stop' });
      expect(r.cmds).toContainEqual({ c: 'wake', op: 'release' });
    }
  });

  it('staff_required opens the staff sheet', () => {
    const { state, key } = sent();
    const r = step(state, { type: 'fail', key, error: 'staff_required' }, at(10));
    expect(r.state.block).toBe('staff');
    expect(r.state.loop.s).toBe('ready');
  });

  it('checking slows at 300 ms (once) and times out at 5 s', () => {
    const { state } = sent();
    const slow = step(state, { type: 'tick' }, at(SCAN_TIMING.SPINNER_DELAY));
    expect(slow.state.loop).toMatchObject({ s: 'checking', slow: true });
    expect(slow.cmds).toEqual([{ c: 'sound', tone: 'read' }]);
    const again = step(slow.state, { type: 'tick' }, at(SCAN_TIMING.SPINNER_DELAY + 10));
    expect(again.cmds).toEqual([]);
    const timeout = step(slow.state, { type: 'tick' }, at(SCAN_TIMING.LOOKUP_TIMEOUT));
    expect(timeout.state.loop).toMatchObject({ outcome: { reason: 'unconfirmed' } });
  });
});

describe('door actions', () => {
  function headsUp() {
    const { state, key } = sent();
    return step(state, answerOf(key, 'heads_up', 'already_done'), at(100));
  }

  it('override uses a new key and carries overrideOf', () => {
    const v = headsUp();
    const r = step(v.state, { type: 'override', actionId: 'check_in' }, at(500));
    expect(r.state.loop).toMatchObject({
      s: 'applying',
      draft: { actionId: 'check_in', override: true },
    });
    const act = r.cmds.find((c) => c.c === 'act');
    expect(act).toMatchObject({ draft: { override: true, overrideOf: expect.any(String) } });
    const original = v.state.loop.s === 'verdict' ? v.state.loop.outcome.scanId : null;
    expect(act && 'draft' in act && act.draft !== 'auto' ? act.draft.overrideOf : null).toBe(
      original,
    );
    expect(act && 'key' in act ? act.key : null).not.toBe(
      v.state.loop.s === 'verdict' ? v.state.loop.input.id : null,
    );
  });

  it('check_required re-sends confirmed', () => {
    const { state, key } = sent();
    const v = step(state, answerOf(key, 'heads_up', 'check_required'), at(100));
    const r = step(v.state, { type: 'override', actionId: 'check_in' }, at(500));
    expect(r.cmds.find((c) => c.c === 'act')).toMatchObject({ draft: { confirmed: true } });
  });

  it('dismiss is ignored while checking', () => {
    const { state } = sent();
    expect(step(state, { type: 'dismiss' }, at(50)).state).toBe(state);
  });

  it('undo sets the pending undo and sends the command; undone clears it', () => {
    const { state, key } = sent();
    const v = step(state, answerOf(key), at(100));
    const u = step(v.state, { type: 'undo', scanId: fixtureOutcome().scanId ?? '' }, at(200));
    expect(u.state.undo).toMatchObject({ scanId: fixtureOutcome().scanId });
    const undoKey = cmdsOf(u.cmds, 'undo')[0];
    expect(undoKey).toBeDefined();
    const done = step(
      u.state,
      { type: 'undone', key: u.state.undo?.key ?? '', outcome: fixtureOutcome('ok') },
      at(300),
    );
    expect(done.state.undo).toBeNull();
    expect(done.cmds).toContainEqual({ c: 'sound', tone: 'undo' });
    expect(done.cmds).toContainEqual({ c: 'beat', beat: 'rewind' });
    expect(done.state.recent[0]?.undoable).toBe(false);
  });
});
