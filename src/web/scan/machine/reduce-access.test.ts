import { beforeEach, describe, expect, it } from 'vitest';
import { accessBeat } from './access-events.ts';
import { exit, grant, heldIn, heldOut } from './access-fixtures.test-support.ts';
import { fixtureInput } from './fixture-data.test-support.ts';
import { states } from './fixtures.test-support.ts';
import { answerOf, at, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';
import type { ScanState } from './types.ts';

beforeEach(resetIds);

/** A verdict from a scan the device just made. */
function shown(outcomeAnswer: ReturnType<typeof grant>, posture: ScanState['posture'] = 'door') {
  const scanned = step({ ...states.ready(), posture }, readOf('GYM-0001'));
  const key = requestKey(scanned.cmds);
  return step(scanned.state, { type: 'answer', key, outcome: outcomeAnswer }, at(100));
}

describe('the beat of an access verdict', () => {
  it.each([
    ['a grant', grant(), 'gate'],
    ['an exit', exit(), 'bye'],
  ] as const)('%s plays %s', (_name, outcome, beat) => {
    expect(shown(outcome).cmds).toContainEqual({ c: 'beat', beat: accessBeat(beat) });
  });
  it('a turnaround hold plays the wrist, a first-time Not tapped in the tilt', () => {
    expect(shown(heldIn()).cmds).toContainEqual({ c: 'beat', beat: 'wrist' });
    expect(shown(heldOut()).cmds).toContainEqual({ c: 'beat', beat: 'wrist' });
    const noEntry = heldOut();
    noEntry.occupancy = noEntry.occupancy && { ...noEntry.occupancy, turnaround: null };
    expect(shown(noEntry).cmds).toContainEqual({ c: 'beat', beat: 'tilt' });
  });
});

describe('Tap in and Tap out', () => {
  it.each(['in', 'out'] as const)(
    'Tap %s re-sends the scan with the direction named',
    (direction) => {
      const held = shown(direction === 'out' ? heldIn() : heldOut());
      const result = step(held.state, { type: 'turn', direction }, at(500));
      const act = result.cmds.find((c) => c.c === 'act');
      expect(act).toMatchObject({ draft: { actionId: expect.any(String), direction } });
      expect(
        act && 'draft' in act && typeof act.draft === 'object' && act.draft.override,
      ).toBeFalsy();
      expect(result.state.loop.s).toBe('applying');
    },
  );
  it('does nothing when no hold is up', () => {
    const ok = shown(grant());
    expect(step(ok.state, { type: 'turn', direction: 'out' }, at(500)).cmds).toEqual([]);
    expect(step(states.ready(), { type: 'turn', direction: 'in' }).cmds).toEqual([]);
  });
});

describe('resolved: a desk lets them in', () => {
  const by = { staff: 'Sam K.', device: 'Office iPad' };
  const refused = () => {
    const o = heldIn();
    o.scanId = 'scan-refused';
    return o;
  };
  it('turns the card that is up, in place, with a relent and a 1.2 s hold', () => {
    const held = shown(refused());
    const result = step(
      held.state,
      { type: 'resolved', of: 'scan-refused', outcome: grant(), by },
      at(5000),
    );
    expect(result.state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'ok', resolvedBy: 'Sam K.', undoUntil: null },
      closeAt: at(5000) + 1200,
    });
    expect(result.state.card).toEqual(held.state.card);
    expect(result.cmds).toContainEqual({ c: 'beat', beat: accessBeat('relent') });
    expect(result.cmds).toContainEqual({ c: 'sound', tone: 'ok' });
  });
  it('keeps the held display so the card keeps its photo', () => {
    const held = shown(refused());
    const display = held.state.loop.s === 'verdict' ? held.state.loop.outcome.display : null;
    const result = step(
      held.state,
      { type: 'resolved', of: 'scan-refused', outcome: grant({ display: null }), by },
      at(5000),
    );
    expect(result.state.loop.s === 'verdict' && result.state.loop.outcome.display).toEqual(display);
  });
  it('after 60 s only the Recent row turns', () => {
    const held = shown(refused());
    const result = step(
      held.state,
      { type: 'resolved', of: 'scan-refused', outcome: grant(), by },
      at(61_000),
    );
    expect(result.state.loop).toEqual(held.state.loop);
    expect(result.cmds).toEqual([]);
    expect(result.state.recent[0]).toMatchObject({
      undoable: false,
      outcome: { kind: 'ok', resolvedBy: 'Sam K.' },
    });
  });
  it('never interrupts a newer scan', () => {
    const held = shown(refused());
    const next = step(held.state, readOf('GYM-0002', {}, 400), at(500));
    const result = step(
      next.state,
      { type: 'resolved', of: 'scan-refused', outcome: grant(), by },
      at(900),
    );
    expect(result.state.loop).toEqual(next.state.loop);
    expect(result.state.recent.find((r) => r.scanId === 'scan-refused')?.outcome.kind).toBe('ok');
  });
  it('another scan id changes nothing on the card', () => {
    const held = shown(refused());
    const result = step(
      held.state,
      { type: 'resolved', of: 'other', outcome: grant(), by },
      at(5000),
    );
    expect(result.state.loop).toEqual(held.state.loop);
  });
  it('a desk posture card settles instead of closing', () => {
    const held = shown(refused(), 'desk');
    const l = held.state.loop;
    if (l.s !== 'verdict') throw new Error('verdict');
    const withCard = { ...held.state, loop: { ...l, card: l.card ?? grant().card } };
    const result = step(
      withCard as ScanState,
      { type: 'resolved', of: 'scan-refused', outcome: grant(), by },
      at(5000),
    );
    const after = result.state.loop;
    expect(after.s === 'verdict' && after.closeAt).toBe(
      after.s === 'verdict' && after.card ? null : at(5000) + 1200,
    );
  });
});

void fixtureInput;
void answerOf;
