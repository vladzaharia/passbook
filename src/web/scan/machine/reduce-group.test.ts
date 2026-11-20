import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureOutcome, states } from './fixtures.test-support.ts';
import { presentOutcome } from './present.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';

beforeEach(resetIds);

const bundle = { id: 'b1', name: 'Family', size: 3, checkedIn: 1 };

function verdictWithChip() {
  const r = step(states.ready(), readOf('AAAA1111'));
  const key = requestKey(r.cmds);
  return step(r.state, answerOf(key, 'ok', null, { bundle }), at(100));
}

describe('bundle check-in', () => {
  it('sends the same scan with group under a new key', () => {
    const v = verdictWithChip();
    const r = step(v.state, { type: 'group' }, at(500));
    expect(r.state.loop).toMatchObject({ s: 'applying', draft: { actionId: 'auto', group: true } });
    const act = r.cmds.find((c) => c.c === 'act');
    expect(act).toMatchObject({ draft: { group: true } });
  });

  it('does nothing without a chip or once the group ran', () => {
    const r = step(states.ready(), readOf('AAAA1111'));
    const plain = step(r.state, answerOf(requestKey(r.cmds)), at(100));
    expect(step(plain.state, { type: 'group' }, at(500)).cmds).toEqual([]);
  });

  it('holds a chip or a partial group longer than a plain ok', () => {
    const hold = (extra: object) =>
      presentOutcome(fixtureOutcome('ok', null, extra), 'door', { holdResults: false }).hold;
    expect(hold({})).toBe(SCAN_TIMING.OK_HOLD);
    expect(hold({ bundle })).toBe(6000);
    expect(hold({ bundle: { ...bundle, checkedIn: 3 } })).toBe(SCAN_TIMING.OK_HOLD);
    expect(hold({ group: { total: 3, done: 2, already: 0, refused: 1 } })).toBe(
      SCAN_TIMING.REFUSED_HOLD,
    );
    expect(hold({ group: { total: 3, done: 3, already: 0, refused: 0 } })).toBe(
      SCAN_TIMING.OK_HOLD,
    );
  });
});

describe('Check in more answers about the person scanned', () => {
  it('keeps their display on the group verdict, so the card is still about them', () => {
    const v = verdictWithChip();
    const lead = v.state.recent[0]?.outcome;
    const sent = step(v.state, { type: 'group' }, at(500));
    const group = {
      total: 3,
      done: 2,
      already: 1,
      refused: 0,
      members: [
        { name: 'Ana', state: 'already' as const, reason: null },
        { name: 'Bo', state: 'done' as const, reason: null },
        { name: 'Cy', state: 'done' as const, reason: null },
      ],
    };
    const answered = step(
      sent.state,
      {
        type: 'answer',
        key: requestKey(sent.cmds),
        outcome: fixtureOutcome('ok', null, { group, display: null, card: null }),
      },
      at(900),
    );
    expect(answered.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { group: { done: 2 }, display: lead?.display },
    });
    expect(answered.cmds.find((c) => c.c === 'announce')).toMatchObject({
      text: expect.stringContaining('Checked in 2 more'),
    });
  });
});
