import { describe, expect, it } from 'vitest';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from './fixtures.test-support.ts';
import { groupAction, groupHeadline, groupSub, groupView } from './group-view.ts';
import { verdictLine } from './verdict-lines.ts';

const bundle = { id: 'b1', name: 'Family pack', size: 4, checkedIn: 1 };
const lead = { card: fixtureCard(), display: fixtureDisplay('ok') };
const m = (name: string, state: 'done' | 'already' | 'refused', reason: string | null = null) => ({
  name,
  state,
  reason,
});

describe('the group on a handheld', () => {
  it('names the group after the person scanned and counts who is in', () => {
    const v = groupView(fixtureOutcome('ok', null, { ...lead, bundle }));
    expect(v && groupSub(v)).toBe("1 of 4 in Anna's group");
    expect(v?.people.map((p) => p.state)).toEqual(['in', 'pending', 'pending', 'pending']);
    expect(v?.people[0]?.name).toBe('Anna');
  });

  it('uses the server members: initials per person, and who is in is theirs', () => {
    const members = [
      { initials: 'AP', checkedIn: true },
      { initials: 'BP', checkedIn: false },
      { initials: '', checkedIn: false },
      { initials: 'DP', checkedIn: true },
    ];
    const v = groupView(
      fixtureOutcome('ok', null, { ...lead, bundle: { ...bundle, checkedIn: 2, members } }),
    );
    expect(v?.people.map((p) => [p.state, p.initials ?? ''])).toEqual([
      ['in', 'AP'],
      ['pending', 'BP'],
      ['pending', ''],
      ['in', 'DP'],
    ]);
    expect(v?.remaining).toBe(2);
  });

  it('counts from the members when there are some, so counts and discs agree', () => {
    const members = [
      { initials: 'AP', checkedIn: true },
      { initials: 'BP', checkedIn: true },
      { initials: 'CP', checkedIn: false },
      { initials: 'DP', checkedIn: false },
    ];
    // The server's own count says 3; the members say 2: the discs win.
    const o = fixtureOutcome('ok', null, { ...lead, bundle: { ...bundle, checkedIn: 3, members } });
    const v = groupView(o);
    expect(v && groupSub(v)).toBe("2 of 4 in Anna's group");
    expect(v?.remaining).toBe(2);
    expect(groupAction(o)?.label).toBe('Check in 2 more');
  });

  it('offers the people left, and nothing when all are in or it is not an entry', () => {
    const ok = fixtureOutcome('ok', null, { ...lead, bundle });
    expect(groupAction(ok)).toEqual({ n: 3, label: 'Check in 3 more' });
    expect(groupAction({ ...ok, bundle: { ...bundle, checkedIn: 4 } })).toBeNull();
    expect(groupAction({ ...ok, kind: 'heads_up' })).toBeNull();
    expect(groupAction({ ...ok, bundle: { ...bundle, size: 1 } })).toBeNull();
  });

  it('after Check in more says how many it added, the first pass counting as in', () => {
    const group = {
      total: 4,
      done: 3,
      already: 1,
      refused: 0,
      members: [
        m('Anna Park', 'already'),
        m('Ben Park', 'done'),
        m('Cara Park', 'done'),
        m('Dan Park', 'done'),
      ],
    };
    const o = fixtureOutcome('ok', null, { ...lead, group });
    const v = groupView(o);
    expect(v && groupHeadline(v)).toBe('Checked in 3 more');
    expect(v && groupSub(v)).toBe("4 of 4 in Anna's group");
    expect(v?.people.map((p) => p.state)).toEqual(['in', 'in', 'in', 'in']);
    expect(verdictLine(o, 0, { group: true })).toEqual({
      headline: 'Checked in 3 more',
      sub: "4 of 4 in Anna's group",
    });
    expect(verdictLine(o, 0)).toBeNull();
  });

  it('shows who was already in or refused as their own state, and counts only who is in', () => {
    const group = {
      total: 4,
      done: 1,
      already: 2,
      refused: 1,
      members: [
        m('Anna', 'already'),
        m('Ben', 'already', 'already_done'),
        m('Cara', 'done'),
        m('Dan', 'refused', 'voided'),
      ],
    };
    const v = groupView(fixtureOutcome('ok', null, { ...lead, group }));
    expect(v?.people.map((p) => p.state)).toEqual(['in', 'already', 'in', 'refused']);
    expect(v && groupSub(v)).toBe("3 of 4 in Anna's group");
    expect(v && groupHeadline(v)).toBe('Checked in 1 more');
  });

  it('falls back to the bundle name with no first name', () => {
    const v = groupView(fixtureOutcome('ok', null, { bundle, display: null, card: null }));
    expect(v && groupSub(v)).toBe('1 of 4 in Family pack');
  });
});
