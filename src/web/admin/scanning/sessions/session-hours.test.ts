import { describe, expect, it } from 'vitest';
import { emptySessionDraft, sessionBody, sessionDraft, sessionReady } from './draft.ts';
import { DEFAULT_HOURS, hoursBody, hoursProblem, hoursSummary } from './session-hours.ts';
import { sessionState, sessionWindowLine } from './session-state.tsx';
import { managedSession } from './test-fixtures.ts';

describe('hours editor validation', () => {
  it('is fine off, and needs a span on', () => {
    expect(hoursProblem(false, undefined)).toBeNull();
    expect(hoursProblem(true, undefined)).toMatch(/at least one span/);
    expect(hoursProblem(true, DEFAULT_HOURS)).toBeNull();
  });
  it('takes an overnight span and refuses equal times', () => {
    expect(hoursProblem(true, { fri: ['18:00-02:00'] })).toBeNull();
    expect(hoursProblem(true, { fri: ['22:00-22:00'] })).toMatch(/differ/);
  });
  it('refuses overlaps, including a spill past midnight into the next day', () => {
    expect(hoursProblem(true, { mon: ['08:00-12:00', '11:00-14:00'] })).toMatch(/overlaps/);
    expect(hoursProblem(true, { fri: ['18:00-02:00'], sat: ['01:00-03:00'] })).toMatch(/overlaps/);
    expect(hoursProblem(true, { fri: ['18:00-02:00'], sat: ['02:00-03:00'] })).toBeNull();
  });
  it('sends hours only when on and valid', () => {
    expect(hoursBody(false, DEFAULT_HOURS)).toBeNull();
    expect(hoursBody(true, { mon: ['09:00-09:00'] })).toBeNull();
    expect(hoursBody(true, DEFAULT_HOURS)).toEqual(DEFAULT_HOURS);
  });
  it('blocks Save while the week is invalid and clears hours when off', () => {
    const draft = { ...emptySessionDraft(), name: 'Gym', orgId: 'o1' };
    expect(sessionReady({ ...draft, hoursOn: true, hours: {} })).toBe(false);
    expect(sessionReady({ ...draft, hoursOn: true, hours: DEFAULT_HOURS })).toBe(true);
    expect(sessionBody({ ...draft, hoursOn: false, hours: DEFAULT_HOURS }).hours).toBeNull();
    const withHours = { ...managedSession, hours: { sat: ['22:00-02:00'] } };
    expect(sessionDraft(withHours)).toMatchObject({
      hoursOn: true,
      hours: { sat: ['22:00-02:00'] },
    });
    expect(sessionDraft(managedSession).hoursOn).toBe(false);
  });
  it('summarizes days that share spans', () => {
    expect(
      hoursSummary({
        mon: ['08:00-22:00'],
        tue: ['08:00-22:00'],
        wed: ['08:00-22:00'],
        sat: ['22:00-02:00'],
      }),
    ).toEqual(['Mon–Wed 8 AM–10 PM', 'Sat 10 PM–2 AM']);
    expect(hoursSummary(null)).toEqual([]);
  });
});

describe('session state', () => {
  const now = Date.parse('2026-11-17T15:00:00Z');
  const base = { ...managedSession, timeZone: 'UTC' };
  const window = (over: object) => ({
    open: false,
    by: 'hours' as const,
    opensAt: null,
    closesAt: null,
    ...over,
  });
  it('pause and end win over hours', () => {
    const closed = window({ opensAt: now + 3_600_000 });
    expect(sessionState({ status: 'paused', window: closed })).toBe('paused');
    expect(sessionState({ status: 'ended', window: closed })).toBe('ended');
    expect(sessionWindowLine({ ...base, status: 'paused', window: closed }, now)).toBeNull();
  });
  it('reads closed, running and always open', () => {
    expect(sessionState({ status: 'active', window: window({}) })).toBe('closed');
    expect(sessionState({ status: 'active', window: window({ open: true }) })).toBe('running');
    expect(sessionState({ status: 'active' })).toBe('running');
    const line = sessionWindowLine({ ...base, window: window({ opensAt: now + 3_600_000 }) }, now);
    expect(line).toMatch(/^Opens 4:00 PM/);
  });
});
