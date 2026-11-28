import { describe, expect, it } from 'vitest';
import {
  fixtureInput,
  fixtureOutcome,
  fixtureState,
  states,
} from '../machine/fixtures.test-support.ts';
import { createNativeSettle, departure, liveIds, onScreen, outcomeOf } from './native-settle.ts';

const setup = (settles = true) => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    s: createNativeSettle(
      (m) => sent.push(m as never),
      () => settles,
    ),
  };
};

describe('native settle table', () => {
  it('sends result once, then revise only when the outcome changes', () => {
    const { sent, s } = setup();
    s.track('a', 'n1');
    expect(s.answer('a', 'error')).toBe(true);
    expect(s.answer('a', 'error')).toBe(false);
    expect(s.answer('a', 'accepted')).toBe(true);
    expect(s.answer('a', 'accepted')).toBe(false);
    expect(sent).toEqual([
      { op: 'result', id: 'n1', outcome: 'error' },
      { op: 'revise', id: 'n1', outcome: 'accepted' },
    ]);
  });

  it('never revises or answers a dropped id', () => {
    const { sent, s } = setup();
    s.track('a', 'n1');
    expect(s.drop('a', 'closed')).toBe(true);
    expect(s.answer('a', 'accepted')).toBe(false);
    expect(s.drop('a', 'closed')).toBe(false);
    expect(sent).toEqual([{ op: 'dropped', id: 'n1', reason: 'closed' }]);
  });

  it('turns every drop into result error without settle, and never revises', () => {
    const { sent, s } = setup(false);
    s.track('a', 'n1');
    s.track('b', 'n2');
    s.drop('a', 'replaced');
    s.dropNative('n3', 'duplicate');
    s.answer('b', 'error');
    s.answer('b', 'accepted');
    expect(sent).toEqual([
      { op: 'result', id: 'n1', outcome: 'error' },
      { op: 'result', id: 'n3', outcome: 'error' },
      { op: 'result', id: 'n2', outcome: 'error' },
    ]);
  });

  it('evicts the oldest pending past 8 as replaced and the oldest answered past 8', () => {
    const { sent, s } = setup();
    for (let i = 0; i < 9; i++) s.track(`a${i}`, `n${i}`);
    expect(sent).toEqual([{ op: 'dropped', id: 'n0', reason: 'replaced' }]);
    expect(s.unanswered()).toHaveLength(8);
    for (let i = 1; i < 9; i++) s.answer(`a${i}`, 'error');
    s.track('z', 'nz');
    s.answer('z', 'error');
    sent.length = 0;
    expect(s.answer('a1', 'accepted')).toBe(false);
    expect(s.answer('a2', 'accepted')).toBe(true);
  });

  it('clear forgets both maps', () => {
    const { sent, s } = setup();
    s.track('a', 'n1');
    s.track('b', 'n2');
    s.answer('b', 'error');
    s.clear();
    expect(s.unanswered()).toEqual([]);
    expect(s.answer('b', 'accepted')).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe('native settle state helpers', () => {
  it('maps outcomes like the display', () => {
    expect(outcomeOf(fixtureOutcome('ok'))).toBe('accepted');
    expect(outcomeOf(fixtureOutcome('refused'))).toBe('rejected');
    expect(outcomeOf(fixtureOutcome('system'))).toBe('error');
  });

  it('liveIds covers the open slot, next and held', () => {
    expect([...liveIds(states.checking())]).toEqual([fixtureInput().id]);
    expect(liveIds(states.ready()).size).toBe(0);
    expect(liveIds(states.held()).size).toBe(2);
  });

  it('onScreen answers a verdict or a desk card, else nothing', () => {
    expect(onScreen(states.ready())).toBeNull();
    expect(onScreen(states.checking())).toBeNull();
    expect(onScreen(states.member())).toMatchObject({ outcome: 'accepted' });
  });

  it('departure tells replaced from closed', () => {
    const held = states.held();
    const heldId = (held.loop as { held: { id: string } }).held.id;
    expect(departure(held, heldId)).toBe('replaced');
    expect(departure(fixtureState(), 'x')).toBe('closed');
  });
});
