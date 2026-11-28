import { describe, expect, it } from 'vitest';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { accessBeat, type ResolvedOutcome } from './access-events.ts';
import {
  accessInfo,
  exit,
  full,
  grant,
  heldIn,
  heldOut,
  occupancyInfo,
  SINCE,
} from './access-fixtures.test-support.ts';
import {
  accessBeatOf,
  accessLines,
  accessValues,
  agoText,
  directionPill,
  holdVerbs,
  stayText,
} from './access-view.ts';
import { FIXTURE_NOW, fixtureOutcome } from './fixture-data.test-support.ts';

const NOW = FIXTURE_NOW;

describe('durations', () => {
  it.each([
    [30_000, '30 s'],
    [12 * 60_000, '12 min'],
    [92 * 60_000, '1 h 32 min'],
    [2 * 3_600_000, '2 h'],
    [(7 * 24 + 15) * 3_600_000 + 34 * 60_000, '7 d 15 h'],
    [48 * 3_600_000, '2 d'],
  ])('stay %i is %s', (ms, text) => expect(stayText(ms)).toBe(text));
  it.each([
    [40_000, '40 s ago'],
    [5 * 60_000, '5 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [23 * 3_600_000, '23 h ago'],
    [352 * 3_600_000, '14 d ago'],
  ])('ago %i is %s', (ms, text) => expect(agoText(ms)).toBe(text));
});

describe('access lines', () => {
  it('a grant says Checked in with the zone and the closing time', () => {
    expect(accessLines(grant(), NOW)).toEqual({
      title: 'Checked in',
      sub: 'Gym · until 9:00 PM',
    });
  });
  it('drops the closing time when access closes in more than 12 hours', () => {
    const o = grant({ access: accessInfo({ closesAt: NOW + 13 * 3_600_000 }) });
    expect(accessLines(o, NOW)?.sub).toBe('Gym');
  });
  it('drops every part that has no value', () => {
    const o = grant({ access: accessInfo({ zone: null }), occupancy: null });
    expect(accessLines(o, NOW)?.sub).toBe('');
  });
  it('an exit says Checked out with the zone and the stay', () => {
    expect(accessLines(exit(), NOW)).toEqual({ title: 'Checked out', sub: 'Gym · 1 h 32 min' });
  });
  it('an event check-in keeps its own words', () => {
    expect(accessLines(fixtureOutcome('ok'), NOW)).toBeNull();
  });
  it('a desk turn says who let them in', () => {
    const o: ResolvedOutcome = { ...grant(), resolvedBy: 'Sam K.' };
    expect(accessLines(o, NOW)).toEqual({ title: 'Checked in', sub: 'Gym · Let in by Sam K.' });
  });
  it('holds use the occupancy copy', () => {
    expect(
      accessLines(
        heldIn({
          occupancy: heldIn().occupancy && { ...heldIn().occupancy!, since: NOW - 40_000 },
        }),
        NOW,
      ),
    ).toEqual({
      title: 'Already in',
      sub: '40 s ago · Front desk. Check ID.',
    });
    expect(accessLines(heldOut(), NOW)).toEqual({
      title: 'Already out',
      sub: '40 s ago · Front desk',
    });
    expect(accessLines(full(), NOW)).toEqual({ title: 'Gym full', sub: '60 of 60 in.' });
  });
});

describe('an event place', () => {
  const gala = { kind: 'event' as const, id: 'e1', name: 'Gala' };
  const at = (over: Parameters<typeof occupancyInfo>[0]) => occupancyInfo({ place: gala, ...over });
  it('a check-in and a check-out keep the event words and the pill names the direction', () => {
    const entered = fixtureOutcome('ok', null, { occupancy: at({}) });
    const left = fixtureOutcome('ok', null, { occupancy: at({ direction: 'out', state: 'out' }) });
    expect([accessLines(entered, NOW), accessLines(left, NOW)]).toEqual([null, null]);
    expect([directionPill(entered), directionPill(left)]).toEqual(['in', 'out']);
  });
  it('holds read Already checked in and Not checked in', () => {
    const inside = fixtureOutcome('heads_up', 'still_inside', {
      occupancy: at({ since: SINCE }),
    });
    const absent = fixtureOutcome('heads_up', 'not_inside', {
      occupancy: at({ state: 'out', since: null }),
    });
    expect(accessLines(inside, NOW)?.title).toBe('Already checked in');
    expect(accessLines(absent, NOW)).toEqual({
      title: 'Not checked in',
      sub: 'Check them in instead?',
    });
  });
  it('a full event keeps the event name with the exact count', () => {
    const o = fixtureOutcome('heads_up', 'capacity_full', {
      occupancy: at({ inNow: 5, capacity: 5, state: 'out', since: null }),
    });
    expect(accessLines(o, NOW)).toBeNull();
    expect(accessValues(o, NOW)).toMatchObject({ in: 5, capacity: 5, zone: 'Gala' });
  });
});

describe('access values', () => {
  it('fills plan, zone, when and limit from the access block', () => {
    const o = grant({
      access: accessInfo({
        nextOpenAt: Date.UTC(2026, 10, 9, 9, 0),
        visits: { used: 2, limit: 5 },
      }),
    });
    expect(accessValues(o, NOW)).toMatchObject({
      plan: 'Gold',
      zone: 'Gym',
      when: 'Mon 9:00 AM',
      limit: 5,
    });
  });
  it('has nothing for a card with no access', () => {
    expect(accessValues(fixtureOutcome('ok'), NOW)).toEqual({});
  });
});

describe('direction pill, beat and holds', () => {
  it('the pill says which way', () => {
    expect(directionPill(grant())).toBe('in');
    expect(directionPill(exit())).toBe('out');
    expect(directionPill(fixtureOutcome('ok'))).toBeNull();
  });
  it('picks gate, bye and relent', () => {
    const turned: ResolvedOutcome = { ...grant(), resolvedBy: 'Sam K.' };
    expect(accessBeatOf(grant())).toBe(accessBeat('gate'));
    expect(accessBeatOf(exit())).toBe(accessBeat('bye'));
    expect(accessBeatOf(turned)).toBe(accessBeat('relent'));
    expect(accessBeatOf(fixtureOutcome('ok'))).toBeNull();
  });
  it('a turnaround hold offers Tap out or Tap in, never Let in', () => {
    expect(holdVerbs(heldIn())).toEqual([
      { kind: 'turn', direction: 'out', label: SCAN_COPY.actions.tapOut },
    ]);
    expect(holdVerbs(heldOut())).toEqual([
      { kind: 'turn', direction: 'in', label: SCAN_COPY.actions.tapIn },
    ]);
  });
  it('a refused inactive pass that is inside offers only Check out', () => {
    const refused = fixtureOutcome('refused', 'voided', { exitAllowed: true });
    expect(holdVerbs(refused)).toEqual([
      { kind: 'turn', direction: 'out', label: SCAN_COPY.actions.checkOut },
    ]);
    expect(holdVerbs(fixtureOutcome('refused', 'voided'))).toEqual([]);
  });
  it('a repeat says Let in; a first entry says Let in', () => {
    const zone = heldIn({ occupancy: { ...heldIn().occupancy!, turnaround: null } });
    expect(holdVerbs(zone)).toEqual([{ kind: 'letIn', label: 'Let in' }]);
    expect(holdVerbs(full())).toEqual([{ kind: 'letIn', label: 'Let in' }]);
    // The PIN, not a bare override, is the way past needs_approval.
    expect(holdVerbs({ ...full(), reason: 'needs_approval' })).toEqual([]);
    for (const reason of ['cooldown', 'not_yet_valid', 'ended', 'capacity_full'] as const)
      expect(
        holdVerbs(
          fixtureOutcome('heads_up', reason, {
            action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
          }),
        ),
      ).toEqual([{ kind: 'letIn', label: 'Let in' }]);
    expect(
      holdVerbs(
        fixtureOutcome('heads_up', 'already_done', {
          action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
        }),
      ),
    ).toEqual([{ kind: 'letIn', label: 'Let in' }]);
    expect(holdVerbs(fixtureOutcome('refused', 'voided'))).toEqual([]);
  });
});
