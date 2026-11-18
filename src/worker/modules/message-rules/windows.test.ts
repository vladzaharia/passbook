import { describe, expect, it } from 'vitest';
import { localDate } from '../../../shared/zoned.ts';
import { nextCheckAt, type RuleTiming, ruleWindow, sendDayOpen } from './windows.ts';

const H = 3_600_000;
const day = (amount: number, when: 'before' | 'after' = 'before'): RuleTiming => ({
  anchor: { kind: 'input', input: 'expiry' },
  offset: { amount, unit: 'day', when },
  yearly: false,
  sendAt: '10:00',
  timeZone: 'Europe/Berlin',
});
const hour = (amount: number, when: 'before' | 'after' = 'before'): RuleTiming => ({
  ...day(amount, when),
  offset: { amount, unit: 'hour', when },
});
// 2026-06-10 08:00 UTC = 10:00 in Berlin.
const NOW = Date.UTC(2026, 5, 10, 8, 0);

describe('ruleWindow', () => {
  it('day, date-only: the local date plus the offset', () => {
    expect(ruleWindow(day(7), 'date', NOW)).toEqual({
      kind: 'date',
      input: 'expiry',
      date: '2026-06-17',
      occurrence: 'anchor',
    });
    expect(ruleWindow(day(7, 'after'), 'date', NOW)).toMatchObject({ date: '2026-06-03' });
  });

  it('uses the rule zone, not UTC, for today', () => {
    const late = Date.UTC(2026, 5, 10, 22, 30); // already 11 June in Berlin
    expect(ruleWindow(day(0), 'date', late)).toMatchObject({ date: '2026-06-11' });
  });

  it('day, date-time: the local day range, 23 h or 25 h on change days', () => {
    const w = ruleWindow(day(7), 'date-time', NOW);
    expect(w).toMatchObject({ kind: 'dateTime', inclusiveEnd: false, occurrence: 'anchor' });
    if (w.kind !== 'dateTime') throw new Error('kind');
    expect(w.fromMs).toBe(Date.UTC(2026, 5, 16, 22, 0));
    expect(w.toMs - w.fromMs).toBe(24 * H);
    const spring = ruleWindow(day(1), 'date-time', Date.UTC(2026, 2, 28, 9, 0)); // anchors 29 Mar
    if (spring.kind !== 'dateTime') throw new Error('kind');
    expect(spring.toMs - spring.fromMs).toBe(23 * H);
    const fall = ruleWindow(day(1), 'date-time', Date.UTC(2026, 9, 24, 9, 0)); // anchors 25 Oct
    if (fall.kind !== 'dateTime') throw new Error('kind');
    expect(fall.toMs - fall.fromMs).toBe(25 * H);
  });

  it('day, yearly: month-day of the target day, year as the occurrence', () => {
    const y = { ...day(0), yearly: true };
    expect(ruleWindow(y, 'date', NOW)).toEqual({
      kind: 'yearly',
      input: 'expiry',
      monthDays: ['06-10'],
      occurrence: 'y2026',
    });
    // Reminder on 27 Dec for a 3 Jan birthday belongs to the 2027 occurrence.
    const w = ruleWindow(
      { ...y, offset: { amount: 7, unit: 'day', when: 'before' } },
      'date',
      Date.UTC(2026, 11, 27, 9),
    );
    expect(w).toMatchObject({ monthDays: ['01-03'], occurrence: 'y2027' });
  });

  it('29 Feb anchors fire on 28 Feb in common years only', () => {
    const y = { ...day(0), yearly: true };
    expect(ruleWindow(y, 'date', Date.UTC(2027, 1, 28, 9))).toMatchObject({
      monthDays: ['02-28', '02-29'],
    });
    expect(ruleWindow(y, 'date', Date.UTC(2028, 1, 28, 9))).toMatchObject({ monthDays: ['02-28'] });
    expect(ruleWindow(y, 'date', Date.UTC(2028, 1, 29, 9))).toMatchObject({ monthDays: ['02-29'] });
  });

  it('hour: anchors due within the last 30 min', () => {
    expect(ruleWindow(hour(1), 'date-time', NOW)).toEqual({
      kind: 'dateTime',
      input: 'expiry',
      fromMs: NOW + H - 30 * 60_000,
      toMs: NOW + H,
      inclusiveEnd: true,
      occurrence: 'anchor',
    });
    expect(ruleWindow(hour(2, 'after'), 'date-time', NOW)).toMatchObject({
      fromMs: NOW - 2 * H - 30 * 60_000,
      toMs: NOW - 2 * H,
    });
  });

  it('hour: 24 real hours across a DST change is not one calendar day', () => {
    const w = ruleWindow(hour(24), 'date-time', Date.UTC(2026, 2, 28, 12, 0));
    if (w.kind !== 'dateTime') throw new Error('kind');
    expect(w.toMs - Date.UTC(2026, 2, 28, 12, 0)).toBe(24 * H);
  });

  it('last scan: the scan day N days ago', () => {
    const rule: RuleTiming = { ...day(21, 'after'), anchor: { kind: 'lastScan' } };
    const w = ruleWindow(rule, 'date-time', NOW);
    if (w.kind !== 'lastScan') throw new Error('kind');
    expect(w.occurrence).toBe('lastScan');
    expect(localDate(w.fromMs, 'Europe/Berlin')).toBe('2026-05-20');
    expect(w.toMs).toBe(Date.UTC(2026, 4, 20, 22, 0));
  });
});

describe('sendDayOpen and nextCheckAt', () => {
  const rule = day(7);
  it('is open from sendAt to 21:00 local', () => {
    expect(sendDayOpen(rule, Date.UTC(2026, 5, 10, 7, 59))).toBe(false);
    expect(sendDayOpen(rule, NOW)).toBe(true);
    expect(sendDayOpen(rule, Date.UTC(2026, 5, 10, 18, 59))).toBe(true);
    expect(sendDayOpen(rule, Date.UTC(2026, 5, 10, 19, 0))).toBe(false);
  });
  it('waits for sendAt, rechecks every 3 h, then goes to tomorrow', () => {
    expect(nextCheckAt(rule, Date.UTC(2026, 5, 10, 5, 0))).toBe(NOW);
    expect(nextCheckAt(rule, NOW)).toBe(NOW + 3 * H);
    expect(nextCheckAt(rule, Date.UTC(2026, 5, 10, 16, 0))).toBe(Date.UTC(2026, 5, 11, 8, 0));
    expect(nextCheckAt(rule, Date.UTC(2026, 5, 10, 18, 0))).toBe(Date.UTC(2026, 5, 11, 8, 0));
  });
  it('keeps 10:00 local the day after a DST change', () => {
    // 28 Mar 16:00 Berlin (CET) -> 29 Mar 10:00 CEST = 08:00 UTC.
    expect(nextCheckAt(rule, Date.UTC(2026, 2, 28, 18, 0))).toBe(Date.UTC(2026, 2, 29, 8, 0));
  });
  it('hours check every 10 min', () => {
    expect(nextCheckAt(hour(1), NOW)).toBe(NOW + 600_000);
  });
});
