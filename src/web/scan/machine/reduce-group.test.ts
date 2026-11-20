import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { fixtureCard, fixtureOutcome, states } from './fixtures.test-support.ts';
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
  const SCAN_ANCHOR = '01900000-0000-7000-8000-0000000000aa';

  function grouped(over: object = {}) {
    const v = verdictWithChip();
    const sent = step(v.state, { type: 'group' }, at(500));
    const answered = step(
      sent.state,
      {
        type: 'answer',
        key: requestKey(sent.cmds),
        outcome: fixtureOutcome('ok', null, {
          group,
          display: null,
          card: null,
          template: null,
          scanId: SCAN_ANCHOR,
          ...over,
        }),
      },
      at(900),
    );
    return { v, answered };
  }

  it('swaps display, template and card from the newest scan, all three', () => {
    const { v, answered } = grouped();
    const lead = v.state.recent[0]?.outcome;
    expect(lead?.template).toBeTruthy();
    expect(answered.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { display: lead?.display, template: lead?.template, card: lead?.card },
    });
  });

  it('leaves the answer alone when the newest scan was not a bundle verdict', () => {
    const plain = step(states.ready(), readOf('BBBB2222'));
    const ok = step(plain.state, answerOf(requestKey(plain.cmds)), at(100));
    const draft = { actionId: 'auto', amount: null, group: true };
    const applying = {
      ...ok.state,
      loop: {
        s: 'applying' as const,
        input: ok.state.loop.s === 'verdict' ? ok.state.loop.input : (undefined as never),
        card: null,
        draft,
        key: 'k-group',
        since: at(500),
        slow: false,
        next: null,
      },
    };
    const mine = fixtureOutcome('ok', null, { group, display: null, card: fixtureCard() });
    const r = step(applying, { type: 'answer', key: 'k-group', outcome: mine }, at(900));
    expect(r.state.loop).toMatchObject({ outcome: { display: null } });
  });

  it('undoes the group as one scan: the anchor, and the row stops being undoable', () => {
    const { answered } = grouped();
    const row = answered.state.recent[0];
    expect(row).toMatchObject({ scanId: SCAN_ANCHOR, undoable: true });
    const asked = step(answered.state, { type: 'undo', scanId: SCAN_ANCHOR }, at(1200));
    // One request for the anchor: the server reverses every member it made (group.test.ts).
    expect(asked.cmds.filter((c) => c.c === 'undo')).toEqual([
      expect.objectContaining({ c: 'undo', scanId: SCAN_ANCHOR }),
    ]);
    const done = step(
      asked.state,
      {
        type: 'undone',
        key: asked.state.undo?.key ?? '',
        outcome: fixtureOutcome('ok', null, {
          scanId: SCAN_ANCHOR,
          action: { id: 'undo', label: 'Undone', kind: 'check_in' },
        }),
      },
      at(1300),
    );
    expect(done.state.recent.find((r) => r.scanId === SCAN_ANCHOR)).toMatchObject({
      undoable: false,
    });
    expect(done.state.loop).toMatchObject({
      outcome: { action: { id: 'undo' }, display: expect.anything() },
    });
  });
});
