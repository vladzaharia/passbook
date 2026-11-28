import { describe, expect, it } from 'vitest';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { fixtureCard, fixtureOutcome } from '../../machine/fixture-data.test-support.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { canNote, factsOf, markOutPlace, membersOf, nextStepOf } from './record-facts.ts';
import {
  type ActionFacts,
  actionsOf,
  bandOf,
  identityOf,
  presenceOf,
  type Rights,
} from './record-model.ts';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const desk: Rights = { role: 'desk', photo: true, markOut: true, note: true };
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  source: 'scan',
  rights: desk,
  passId: 'p1',
  name: 'Maya Okafor',
  addPhoto: false,
  markOut: false,
  ...over,
});
const band = (o: ScanOutcome, source: 'scan' | 'open' = 'scan') =>
  bandOf(o, source, { now: NOW, desk: true });
const bundle = { id: 'b', name: 'Okafor family', size: 3, checkedIn: 1 };

describe('band', () => {
  it('is neutral and asks for a choice for a desk card a scan is holding', () => {
    const o = fixtureOutcome('ready', 'choose', { card: fixtureCard() });
    expect(band(o)).toMatchObject({ tone: 'preview', title: 'Choose an action' });
  });
  it('has no band for a pass opened from a list', () => {
    expect(band(fixtureOutcome('ready', 'choose', { card: fixtureCard() }), 'open')).toBeNull();
  });
  it('is green for a check-in, amber for a hold, red for a refusal', () => {
    expect(
      band(
        fixtureOutcome('ok', null, {
          action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
        }),
      ),
    ).toMatchObject({ tone: 'ok', title: 'Checked in' });
    expect(band(fixtureOutcome('heads_up', 'already_done'))?.tone).toBe('hu');
    expect(band(fixtureOutcome('refused', 'guest_visits_used'))?.tone).toBe('no');
  });
  it('says a read saved offline is a check-in, saved', () => {
    const o = { ...fixtureOutcome('ok'), kind: 'queued' as const };
    expect(band(o)).toMatchObject({ tone: 'ok', sub: 'Saved offline' });
  });
});

describe('primary action', () => {
  const ready = (over = {}) => fixtureOutcome('ready', 'choose', { card: fixtureCard(over) });
  const checkIn = {
    id: 'check_in',
    label: 'Check in',
    kind: 'check_in' as const,
    available: true,
    lock: null,
    reason: null,
    amount: null,
    confirm: false,
    confirmAbove: null,
    cooldownRemainingMs: null,
    armable: null,
    rewardLabel: null,
  };
  const stamp = fixtureCard().actions[0];

  it('is Check in on a ready card, ahead of a value action', () => {
    const a = actionsOf(ready({ actions: [stamp!, checkIn] }), facts());
    expect(a.primary).toMatchObject({ id: 'check_in', key: 'Enter', run: { t: 'pick' } });
    expect(a.others.map((x) => x.id)).toEqual(['add_stamp', 'note']);
  });
  it('is the template first action when there is no check-in', () => {
    expect(actionsOf(ready(), facts()).primary?.id).toBe('add_stamp');
  });
  it('keeps a Manager-locked action in its place', () => {
    const a = actionsOf(ready(), facts());
    expect(a.others.find((x) => x.id === 'redeem')).toMatchObject({
      lock: 'approval',
      icon: 'shield',
    });
  });
  it('from a list a check-in goes to the machine and another action opens the desk', () => {
    const a = actionsOf(ready({ actions: [stamp!, checkIn] }), facts({ source: 'open' }));
    expect(a.primary?.run).toEqual({ t: 'check-in', actionId: 'check_in' });
    expect(a.others[0]?.run).toMatchObject({ t: 'open' });
  });
  it('says what a check-in costs', () => {
    const access = {
      plan: { id: 'p', label: 'Pack', kind: 'guest' as const },
      zone: null,
      closesAt: null,
      nextOpenAt: null,
      visits: { used: 3, limit: 10 },
      visit: true,
      timeZone: 'UTC',
    };
    expect(actionsOf(ready({ actions: [checkIn], access }), facts()).reason).toBe(
      'Uses 1 visit. 6 left after this.',
    );
    const last = { ...access, visits: { used: 9, limit: 10 } };
    expect(actionsOf(ready({ actions: [checkIn], access: last }), facts()).reason).toBe(
      'Uses 1 visit. None left after this.',
    );
  });
  it('is Let in on an overridable hold', () => {
    const o = fixtureOutcome('heads_up', 'already_done', {
      action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
    });
    expect(actionsOf(o, facts()).primary).toMatchObject({
      label: 'Let in',
      run: { t: 'override', actionId: 'check_in' },
    });
  });
  it('is Ask a manager for a verdict that needs one', () => {
    const o = fixtureOutcome('refused', 'needs_approval', { approvals: true });
    expect(actionsOf(o, facts()).primary).toMatchObject({
      label: 'Ask a manager',
      run: { t: 'ask' },
    });
  });
  it('is Check in family when the bundle has others out, and nothing once all are in', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    expect(actionsOf(o, facts()).primary).toMatchObject({
      label: 'Check in family · 2',
      run: { t: 'group' },
    });
    expect(actionsOf({ ...o, bundle: { ...bundle, checkedIn: 3 } }, facts()).primary).toBeNull();
  });
  it('offers no override on a plain refusal', () => {
    expect(
      actionsOf(fixtureOutcome('refused', 'guest_visits_used'), facts()).primary?.run.t,
    ).not.toBe('override');
  });
  it('lists Mark out, Note and Photo after the primary, each with its key', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    const a = actionsOf(o, facts({ markOut: true, addPhoto: true }));
    expect(a.others.map((x) => [x.id, x.key])).toEqual([
      ['out', 'O'],
      ['note', 'N'],
      ['photo', 'P'],
    ]);
  });
  it('offers a note only where the rights say so and with a pass', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    const has = (f: Partial<ActionFacts>) =>
      actionsOf(o, facts(f)).others.some((x) => x.id === 'note');
    expect(has({ rights: { ...desk, role: 'manager' } })).toBe(true);
    expect(has({ rights: { ...desk, note: false } })).toBe(false);
    expect(has({ passId: null })).toBe(false);
  });
  it('leaves out what the role may not do', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    const noMark: Rights = { ...desk, markOut: false };
    expect(actionsOf(o, facts({ rights: noMark, markOut: true })).others.map((x) => x.id)).toEqual([
      'note',
    ]);
  });
  it('reads a card whose actions are all role-locked as view only', () => {
    const locked = fixtureCard().actions.map((a) => ({
      ...a,
      available: false,
      lock: 'role' as const,
    }));
    expect(actionsOf(ready({ actions: locked }), facts()).viewOnly).toBe(true);
  });
});

describe('presence', () => {
  it('reads the place count first', () => {
    const o = fixtureOutcome('ok', null, {
      occupancy: {
        place: { kind: 'zone', id: 'z', name: 'Gym floor' },
        direction: 'in',
        auto: false,
        state: 'in',
        since: NOW,
        via: null,
        stayMs: null,
        inNow: 1,
        capacity: null,
        turnaround: null,
      },
    });
    expect(presenceOf(o, 'UTC')?.state).toBe('in');
    expect(presenceOf(o, 'UTC')?.line).toMatch(/^since 6:00 PM( UTC)? · Gym floor$/);
    expect(markOutPlace(o)).toBe('zone:z');
  });
  it('is Not in today for a door pass that has not entered, and hidden for a stamp card', () => {
    expect(
      presenceOf(
        fixtureOutcome('ready', 'choose', { card: fixtureCard({ door: { state: null } }) }),
      ),
    ).toEqual({ state: 'none', line: null });
    expect(presenceOf(fixtureOutcome('ready', 'choose', { card: fixtureCard() }))).toBeNull();
  });
});

describe('identity', () => {
  it('shows a refusal as a name and the pass type, without photo or chips', () => {
    const o = fixtureOutcome('refused', 'guest_visits_used', {
      card: fixtureCard({ flags: [{ label: 'VIP', tone: 'neutral', stop: false }] }),
    });
    const who = identityOf(o);
    expect(who?.chips).toEqual([]);
    expect(who?.photoUrl).toBeNull();
  });
  it('lists the type, then the flags', () => {
    const o = fixtureOutcome('ready', 'choose', {
      card: fixtureCard({ flags: [{ label: 'Long stay', tone: 'warning', stop: false }] }),
    });
    expect(identityOf(o)?.chips.map((c) => c.text)).toContain('Long stay');
  });
});

describe('a refusal is never a dead end', () => {
  const checkIn = { id: 'check_in', label: 'Check in', kind: 'check_in' as const };
  const access = {
    plan: { id: 'g', label: 'Guest pass', kind: 'guest' as const },
    zone: null,
    closesAt: null,
    nextOpenAt: null,
    visits: { used: 1, limit: 1 },
    visit: false,
    timeZone: 'UTC',
  };
  const refused = fixtureOutcome('refused', 'guest_visits_used', {
    access,
    card: fixtureCard({ validUntil: NOW + 86_400_000 }),
  });
  it('offers Open pass as the primary and Look up beside it, with a next step', () => {
    const a = actionsOf(refused, facts());
    expect(a.primary).toMatchObject({ label: 'Open pass', run: { t: 'show-pass', passId: 'p1' } });
    expect(a.others[0]).toMatchObject({
      label: 'Look up',
      run: { t: 'look-up', q: 'Maya Okafor' },
    });
    expect(a.reason).toBe('Ask them to renew.');
  });
  it('keeps the override first and Open pass after it on a hold', () => {
    const o = fixtureOutcome('heads_up', 'already_done', { action: checkIn });
    const a = actionsOf(o, facts());
    expect(a.primary?.run.t).toBe('override');
    expect(a.others.map((x) => x.id)).toEqual(['show-pass', 'look-up', 'note']);
  });
  it('has Look up alone for a code that named no pass', () => {
    const a = actionsOf(
      fixtureOutcome('refused', 'not_found'),
      facts({ passId: null, name: null }),
    );
    expect(a.primary).toBeNull();
    expect(a.others.map((x) => x.id)).toEqual(['look-up']);
    expect(a.reason).toBe('Look them up by name.');
  });
  it('says why: plan, visits used, validity and the last time in', () => {
    const facts4 = factsOf(
      {
        ...refused,
        previous: {
          scanId: 's',
          at: NOW - 60_000,
          scannerName: 'Turnstile A',
          staffName: null,
          actionLabel: 'Check in',
          override: false,
        },
      },
      'UTC',
    );
    expect(facts4.map((f) => f.label)).toEqual(['Plan', 'Visits', 'Valid until', 'Last in']);
    expect(facts4[1]?.value).toBe('1 of 1 used');
  });
  it('has a step for every reason', () => {
    expect(nextStepOf(fixtureOutcome('refused', 'expired'))).toBe('Ask them to renew.');
    expect(nextStepOf(fixtureOutcome('refused', 'tag_lost'))).toBe(
      'Look up another pass of theirs.',
    );
  });
});

describe('family members', () => {
  it('reads members when the server sends them and falls back to counts without', () => {
    expect(membersOf({ size: 2, checkedIn: 1 })).toBeNull();
    expect(membersOf(null)).toBeNull();
    expect(
      membersOf({
        members: [
          { initials: 'MO', checkedIn: true },
          { initials: 'CO', checkedIn: false, refusedReason: 'expired' },
        ],
      }),
    ).toEqual([
      { initials: 'MO', checkedIn: true },
      { initials: 'CO', checkedIn: false, refusedReason: 'expired' },
    ]);
  });
});

describe('who may add a note', () => {
  const base = {
    principal: 'scanner',
    scanner: { kind: 'device', deviceRole: 'scan' },
    workspace: { session: { status: 'active', window: { open: true } } },
  } as never as ScanSession;
  const with_ = (over: object) => ({ ...(base as object), ...over }) as ScanSession;
  it('is Desk and above on a paired scan device in a live session', () => {
    expect(canNote(base, 'desk')).toBe(true);
    expect(canNote(base, 'manager')).toBe(true);
    expect(canNote(base, 'door')).toBe(false);
    expect(canNote(base, null)).toBe(false);
  });
  it('is not offered to a console, a terminal, a screen, or a paused or closed session', () => {
    expect(canNote(with_({ principal: 'admin' }), 'manager')).toBe(false);
    expect(canNote(with_({ scanner: { kind: 'terminal', deviceRole: 'scan' } }), 'desk')).toBe(
      false,
    );
    expect(canNote(with_({ scanner: { kind: 'device', deviceRole: 'monitor' } }), 'desk')).toBe(
      false,
    );
    for (const session of [
      { status: 'paused', window: { open: true } },
      { status: 'active', window: { open: false } },
    ])
      expect(canNote(with_({ workspace: { session } }), 'desk')).toBe(false);
  });
});
