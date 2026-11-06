import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureInput, fixtureOutcome, fixtureState, states } from './fixtures.test-support.ts';
import {
  answerOf,
  at,
  cmdsOf,
  hasCmd,
  nextId,
  play,
  readOf,
  requestKey,
  resetIds,
  step,
} from './reduce.test-support.ts';

beforeEach(resetIds);

const inputOf = (e: ReturnType<typeof readOf>) => {
  if (e.type !== 'read') throw new Error('not a read');
  return e.input;
};

describe('read: ready and paused', () => {
  it('a camera read enters checking, freezes the frame and sends an act at the door', () => {
    const { state, cmds } = step(states.ready(), readOf('AAAA1111'));
    expect(state.loop).toMatchObject({ s: 'checking', slow: false, next: null });
    expect(cmds.map((c) => c.c)).toEqual(['camera', 'beat', 'act']);
    expect(cmds[0]).toEqual({ c: 'camera', op: 'pause' });
    expect(cmds[1]).toEqual({ c: 'beat', beat: 'lock' });
    expect(cmds[2]).toMatchObject({ c: 'act', draft: 'auto' });
  });

  it('a wedge read looks instead of locking', () => {
    const { cmds } = step(states.ready(), readOf('AAAA1111', { method: 'wedge' }));
    expect(cmds).toContainEqual({ c: 'beat', beat: 'look' });
  });

  it('the desk posture sends resolve; an armed ready action sends act even at the desk', () => {
    const desk = fixtureState({ posture: 'desk' });
    expect(hasCmd(step(desk, readOf('AAAA1111')).cmds, 'resolve')).toBe(true);
    const armed = fixtureState({
      posture: 'desk',
      armed: { actionId: 'add_stamp', amount: 1, sticky: true },
    });
    const { cmds } = step(armed, readOf('AAAA1111'));
    expect(cmds.find((c) => c.c === 'act')).toMatchObject({
      draft: { actionId: 'add_stamp', amount: 1 },
    });
  });

  it('an ignored code gives a chip and no request', () => {
    const accepted = fixtureState({
      ignore: [{ sig: 'c:AAAA1111', until: at(4000), why: 'accepted' }],
    });
    const a = step(accepted, readOf('AAAA1111'));
    expect(a.cmds).toEqual([{ c: 'chip', chip: 'just_now' }]);
    expect(a.state.loop.s).toBe('ready');
    const refused = fixtureState({
      ignore: [{ sig: 'c:AAAA1111', until: at(4000), why: 'refused', headline: 'Voided' }],
    });
    expect(step(refused, readOf('AAAA1111')).cmds).toEqual([
      { c: 'chip', chip: { same: 'Voided' } },
    ]);
  });

  it('a read in paused enters checking; a hidden pause is kept for the way back', () => {
    const hidden = step(states.paused('hidden'), readOf('AAAA1111'));
    expect(hidden.state.loop.s).toBe('checking');
    expect(cmdsOf(hidden.cmds, 'camera')).toEqual([]);
    const idle = step(states.paused('idle'), readOf('AAAA1111'));
    expect(idle.cmds).toContainEqual({ c: 'camera', op: 'resume' });
  });

  it('a local refusal skips the network and shows a refusal', () => {
    const { state, cmds } = step(states.ready(), readOf('x', { local: 'add_link' }));
    expect(state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'refused', reason: 'add_link', local: true },
    });
    expect(hasCmd(cmds, 'act')).toBe(false);
    expect(hasCmd(cmds, 'resolve')).toBe(false);
    expect(cmds).toContainEqual({ c: 'sound', tone: 'refused' });
  });

  it('offline before sending gives system network with no request', () => {
    const { state, cmds } = step(fixtureState({ online: false }), readOf('AAAA1111'));
    expect(state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'system', reason: 'network' },
    });
    expect(hasCmd(cmds, 'act')).toBe(false);
  });

  it('is ignored while a block panel is up', () => {
    const { state, cmds } = step(states.block('revoked'), readOf('AAAA1111'));
    expect(state.loop.s).toBe('ready');
    expect(cmds).toEqual([]);
  });
});

describe('read: checking and applying', () => {
  it('the same code is dropped; a different code is kept as next, newest wins', () => {
    const first = step(states.ready(), readOf('AAAA1111'));
    const same = step(first.state, readOf('AAAA1111'), at(50));
    expect(same.state.loop).toMatchObject({ s: 'checking', next: null });
    const other = step(first.state, readOf('BBBB2222'), at(60));
    expect(other.state.loop).toMatchObject({ s: 'checking', next: { sig: 'c:BBBB2222' } });
    const newer = step(other.state, readOf('CCCC3333'), at(70));
    expect(newer.state.loop).toMatchObject({ s: 'checking', next: { sig: 'c:CCCC3333' } });
    expect(hasCmd(newer.cmds, 'act')).toBe(false);
  });

  it('applying keeps a different code as next too', () => {
    const { state } = step(states.applying(), readOf('BBBB2222'));
    expect(state.loop).toMatchObject({ s: 'applying', next: { sig: 'c:BBBB2222' } });
  });

  it('an ignored different code is dropped', () => {
    const s = fixtureState({
      loop: states.checking().loop,
      ignore: [{ sig: 'c:ZZZZ', until: at(1000), why: 'accepted' }],
    });
    const { state } = step(s, readOf('ZZZZ'));
    expect(state.loop).toMatchObject({ next: null });
  });
});

describe('read: member, picker and reviewing', () => {
  it('the same code gives already_open', () => {
    const { cmds } = step(states.member(), {
      type: 'read',
      input: fixtureInput({ id: nextId() }),
    });
    expect(cmds).toEqual([{ c: 'chip', chip: 'already_open' }]);
  });

  it('a different code with no picker checks over the card', () => {
    const { state, cmds } = step(states.member(), readOf('BBBB2222'));
    expect(state.loop.s).toBe('checking');
    expect(state.card?.phase).toBe('up');
    expect(hasCmd(cmds, 'resolve')).toBe(true); // a desk member card checks the next code with resolve
  });

  it('a different code with a picker open is held with the heads-up chirp', () => {
    const { state, cmds } = step(states.picking(), readOf('BBBB2222'));
    expect(state.loop).toMatchObject({ s: 'member', held: { sig: 'c:BBBB2222' } });
    expect(cmds).toEqual([{ c: 'sound', tone: 'heads_up' }]);
  });

  it('a different code while reviewing is held', () => {
    const { state } = step(states.reviewing(), readOf('BBBB2222'));
    expect(state.loop).toMatchObject({ s: 'reviewing', held: { sig: 'c:BBBB2222' } });
  });

  it('Switch checks the held code; Keep editing drops it', () => {
    const held = states.held();
    const sw = step(held, { type: 'switch' });
    expect(sw.state.loop).toMatchObject({ s: 'checking', input: { sig: 'c:OTHER' } });
    const keep = step(held, { type: 'keep' });
    expect(keep.state.loop).toMatchObject({ s: 'member', held: null });
  });
});

describe('read: verdict', () => {
  const verdict = () => {
    const sent = step(states.ready(), readOf('AAAA1111'));
    return step(sent.state, answerOf(requestKey(sent.cmds)), at(100));
  };

  it('does not pause decoding: the camera resumes at T0', () => {
    const sent = step(states.ready(), readOf('AAAA1111'));
    const done = step(sent.state, answerOf(requestKey(sent.cmds)), at(100));
    expect(done.cmds).toContainEqual({ c: 'camera', op: 'resume' });
  });

  it('a different code at T0 + 349 is held as next; at T0 + 350 it checks', () => {
    const v = verdict();
    const early = step(v.state, readOf('BBBB2222'), at(100 + 349));
    expect(early.state.loop).toMatchObject({ s: 'verdict', next: { sig: 'c:BBBB2222' } });
    expect(hasCmd(early.cmds, 'act')).toBe(false);
    const late = step(v.state, readOf('BBBB2222'), at(100 + 350));
    expect(late.state.loop.s).toBe('checking');
    expect(late.cmds[0]).toEqual({ c: 'beat', beat: 'cut' });
    expect(hasCmd(late.cmds, 'act')).toBe(true);
    expect(late.state.card?.phase).toBe('rising'); // the old card stays up until the next verdict swaps it
  });

  it('the same code gives just_now, except on a system verdict where it checks again', () => {
    const v = verdict();
    const same = step(v.state, readOf('AAAA1111'), at(900));
    expect(same.cmds).toEqual([{ c: 'chip', chip: 'just_now' }]);
    const sent = step(states.ready(), readOf('AAAA1111'));
    const failed = step(
      sent.state,
      { type: 'fail', key: requestKey(sent.cmds), error: 'server' },
      at(50),
    );
    const again = step(failed.state, readOf('AAAA1111'), at(900));
    expect(again.state.loop.s).toBe('checking');
  });

  it('the same code is ignored for 5,000 ms after ok and sent at 5,001', () => {
    const v = verdict(); // ok answered at +100
    const closed = step(v.state, { type: 'tick' }, at(100 + SCAN_TIMING.OK_HOLD));
    expect(closed.state.loop.s).toBe('ready');
    const inside = step(closed.state, readOf('AAAA1111'), at(100 + 5000));
    expect(inside.cmds).toEqual([{ c: 'chip', chip: 'just_now' }]);
    const outside = step(closed.state, readOf('AAAA1111'), at(100 + 5001));
    expect(hasCmd(outside.cmds, 'act')).toBe(true);
  });

  it('a refusal ignores the code for 30 s and the chip carries the headline', () => {
    const sent = step(states.ready(), readOf('AAAA1111'));
    const key = requestKey(sent.cmds);
    const v = step(sent.state, answerOf(key, 'refused', 'voided'), at(100));
    const closed = step(v.state, { type: 'dismiss' }, at(200));
    const chip = step(closed.state, readOf('AAAA1111'), at(100 + 29_999));
    expect(chip.cmds).toEqual([{ c: 'chip', chip: { same: 'Voided' } }]);
    expect(hasCmd(step(closed.state, readOf('AAAA1111'), at(100 + 30_001)).cmds, 'act')).toBe(true);
  });

  it('a verdict opens a different code from openFrom (350 after T0)', () => {
    const s = states.verdict('ok');
    const { state } = step(s, readOf('BBBB2222'), s.loop.s === 'verdict' ? s.loop.openFrom : 0);
    expect(state.loop.s).toBe('checking');
    expect(inputOf(readOf('x')).sig).toBe('c:x');
    expect(fixtureOutcome('ok').kind).toBe('ok');
    expect(play(states.ready(), []).state.loop.s).toBe('ready');
  });
});
