import { describe, expect, it } from 'vitest';
import { fixtureCard, fixtureOutcome } from '../../machine/fixture-data.test-support.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import {
  type ActionFacts,
  actionsOf,
  bandOf,
  identityOf,
  markOutPlace,
  presenceOf,
  type Rights,
} from './record-model.ts';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const desk: Rights = { role: 'desk', photo: true, markOut: true };
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  source: 'scan',
  rights: desk,
  addPhoto: false,
  markOut: false,
  ...over,
});
const band = (o: ScanOutcome, source: 'scan' | 'open' | 'search' = 'scan') =>
  bandOf(o, source, { now: NOW, desk: true });
const bundle = { id: 'b', name: 'Okafor family', size: 3, checkedIn: 1 };

describe('band', () => {
  it('is neutral for a search hit and says nothing was changed', () => {
    const o = fixtureOutcome('ready', 'choose', { card: fixtureCard() });
    expect(band(o, 'search')).toMatchObject({
      tone: 'preview',
      title: 'Found by name. Nothing changed yet.',
    });
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
    expect(a.others.map((x) => x.id)).toEqual(['add_stamp']);
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
  it('is Let in anyway on an overridable hold', () => {
    const o = fixtureOutcome('heads_up', 'already_done', {
      action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
    });
    expect(actionsOf(o, facts()).primary).toMatchObject({
      label: 'Let in again',
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
  it('offers nothing on a refusal with no override', () => {
    expect(actionsOf(fixtureOutcome('refused', 'guest_visits_used'), facts()).primary).toBeNull();
  });
  it('lists Mark out and Photo after the primary, each with its key', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    const a = actionsOf(o, facts({ markOut: true, addPhoto: true }));
    expect(a.others.map((x) => [x.id, x.key])).toEqual([
      ['out', 'O'],
      ['photo', 'P'],
    ]);
  });
  it('leaves out what the role may not do', () => {
    const o = fixtureOutcome('ok', null, { bundle });
    const noMark: Rights = { ...desk, markOut: false };
    expect(actionsOf(o, facts({ rights: noMark, markOut: true })).others).toEqual([]);
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
    expect(presenceOf(o, 'UTC')).toEqual({ state: 'in', line: 'since 6:00 PM · Gym floor' });
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
