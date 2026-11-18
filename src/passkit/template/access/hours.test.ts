import { describe, expect, it } from 'vitest';
import { closesAt, endOfDay, instantOf, isOpen, nextOpen, parseSpan, wall } from './hours.ts';

const NY = 'America/New_York';
const LON = 'Europe/London';
const z = (s: string) => Date.parse(s);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const daily = (span: string) => ({
  mon: [span],
  tue: [span],
  wed: [span],
  thu: [span],
  fri: [span],
  sat: [span],
  sun: [span],
});

describe('parseSpan', () => {
  it('reads a span, overnight and 24:00', () => {
    expect(parseSpan('06:00-10:00')).toEqual({ start: 360, end: 600 });
    expect(parseSpan('22:00-02:00')).toEqual({ start: 1320, end: 1560 });
    expect(parseSpan('00:00-24:00')).toEqual({ start: 0, end: 1440 });
    expect(parseSpan('18:30-24:00')).toEqual({ start: 1110, end: 1440 });
  });
  it('refuses bad spans', () => {
    for (const bad of [
      '06:00-06:00',
      '24:00-02:00',
      '6:00-10:00',
      '06:60-10:00',
      '06:00-25:00',
      '',
      5,
    ])
      expect(parseSpan(bad)).toBeNull();
  });
});

describe('wall and instantOf', () => {
  it('reads local parts, Monday first', () => {
    expect(wall(z('2026-11-16T15:30:00Z'), NY)).toEqual({
      y: 2026,
      m: 11,
      d: 16,
      dow: 0,
      min: 630,
    });
    expect(wall(z('2026-11-15T23:00:00Z'), 'Asia/Kolkata')).toMatchObject({
      d: 16,
      dow: 0,
      min: 270,
    });
  });
  it('New York: a time in the spring gap is the gap end; an autumn repeat is the earlier', () => {
    expect(iso(instantOf(NY, 2026, 3, 8, 150))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(instantOf(NY, 2026, 3, 8, 360))).toBe('2026-03-08T10:00:00.000Z');
    expect(iso(instantOf(NY, 2026, 11, 1, 90))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(instantOf(NY, 2026, 11, 1, 120))).toBe('2026-11-01T07:00:00.000Z');
  });
  it('London: gap and repeat', () => {
    expect(iso(instantOf(LON, 2026, 3, 29, 90))).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(instantOf(LON, 2026, 10, 25, 90))).toBe('2026-10-25T00:30:00.000Z');
  });
  it('Kolkata has a half-hour offset and no DST', () => {
    expect(iso(instantOf('Asia/Kolkata', 2026, 1, 5, 360))).toBe('2026-01-05T00:30:00.000Z');
    expect(iso(instantOf('Asia/Kolkata', 2026, 7, 5, 360))).toBe('2026-07-05T00:30:00.000Z');
  });
  it('Lord Howe shifts by 30 minutes', () => {
    expect(iso(instantOf('Australia/Lord_Howe', 2026, 10, 4, 135))).toBe(
      '2026-10-03T15:30:00.000Z',
    );
    expect(iso(instantOf('Australia/Lord_Howe', 2026, 4, 5, 105))).toBe('2026-04-04T14:45:00.000Z');
  });
  it('endOfDay is the next local midnight, 23 and 25 hour days included', () => {
    expect(iso(endOfDay(z('2026-03-08T12:00:00Z'), NY))).toBe('2026-03-09T04:00:00.000Z');
    expect(iso(endOfDay(z('2026-11-01T12:00:00Z'), NY))).toBe('2026-11-02T05:00:00.000Z');
    expect(iso(endOfDay(z('2026-11-16T12:00:00Z'), NY, 3))).toBe('2026-11-19T05:00:00.000Z');
  });
});

describe('isOpen', () => {
  const week = { mon: ['06:00-10:00', '20:00-23:00'] };
  it('opens at the start and closes at the end', () => {
    expect(isOpen(week, 'UTC', z('2026-11-16T05:59:00Z'))).toBe(false);
    expect(isOpen(week, 'UTC', z('2026-11-16T06:00:00Z'))).toBe(true);
    expect(isOpen(week, 'UTC', z('2026-11-16T09:59:00Z'))).toBe(true);
    expect(isOpen(week, 'UTC', z('2026-11-16T10:00:00Z'))).toBe(false);
    expect(isOpen(week, 'UTC', z('2026-11-16T21:00:00Z'))).toBe(true);
    expect(isOpen(week, 'UTC', z('2026-11-17T07:00:00Z'))).toBe(false);
  });
  it('no hours means always open; an empty week never', () => {
    expect(isOpen(undefined, 'UTC', 0)).toBe(true);
    expect(isOpen({}, 'UTC', 0)).toBe(false);
  });
  it('a midnight-spanning span belongs to the day it starts, Sunday into Monday', () => {
    const hours = { fri: ['22:00-02:00'], sun: ['23:00-03:00'] };
    expect(isOpen(hours, 'UTC', z('2026-11-20T23:00:00Z'))).toBe(true);
    expect(isOpen(hours, 'UTC', z('2026-11-21T01:59:00Z'))).toBe(true);
    expect(isOpen(hours, 'UTC', z('2026-11-21T02:00:00Z'))).toBe(false);
    expect(isOpen(hours, 'UTC', z('2026-11-20T01:00:00Z'))).toBe(false);
    expect(isOpen(hours, 'UTC', z('2026-11-16T02:59:00Z'))).toBe(true);
    expect(isOpen(hours, 'UTC', z('2026-11-16T03:00:00Z'))).toBe(false);
  });
  it('uses the zone clock', () => {
    const hours = { mon: ['06:00-10:00'] };
    expect(isOpen(hours, NY, z('2026-11-16T10:00:00Z'))).toBe(false);
    expect(isOpen(hours, NY, z('2026-11-16T11:00:00Z'))).toBe(true);
  });
});

describe('nextOpen and closesAt', () => {
  it('cross midnight and the week', () => {
    const hours = { fri: ['22:00-02:00'] };
    const sat1 = z('2026-11-21T01:00:00Z');
    expect(iso(closesAt([hours], 'UTC', sat1))).toBe('2026-11-21T02:00:00.000Z');
    expect(iso(nextOpen([hours], 'UTC', sat1 + 3_600_000))).toBe('2026-11-27T22:00:00.000Z');
    expect(nextOpen([hours], 'UTC', z('2026-11-21T03:00:00Z'))).toBe(z('2026-11-27T22:00:00Z'));
  });
  it('contiguous spans across midnight are one stretch', () => {
    const hours = { mon: ['08:00-24:00'], tue: ['00:00-02:00'] };
    expect(iso(closesAt([hours], 'UTC', z('2026-11-16T09:00:00Z')))).toBe(
      '2026-11-17T02:00:00.000Z',
    );
  });
  it('null when nothing opens within 7 days, or nothing closes', () => {
    expect(nextOpen([{ mon: ['06:00-10:00'] }], 'UTC', z('2026-11-16T11:00:00Z'))).toBe(
      z('2026-11-23T06:00:00Z'),
    );
    expect(
      nextOpen([{ mon: ['06:00-10:00'] }], 'UTC', z('2026-11-16T10:00:00Z') + 60_000),
    ).not.toBeNull();
    expect(nextOpen([{}], 'UTC', 0)).toBeNull();
    expect(closesAt([daily('00:00-24:00')], 'UTC', z('2026-11-16T09:00:00Z'))).toBeNull();
  });
  it('an intersection opens when both do', () => {
    const plan = daily('06:00-22:00');
    const grant = daily('06:00-10:00');
    expect(iso(nextOpen([plan, grant], 'UTC', z('2026-11-16T11:00:00Z')))).toBe(
      '2026-11-17T06:00:00.000Z',
    );
    expect(iso(closesAt([plan, grant], 'UTC', z('2026-11-16T07:00:00Z')))).toBe(
      '2026-11-16T10:00:00.000Z',
    );
  });
});

describe('DST', () => {
  it('New York spring: 06:00-10:00 stays 06:00-10:00 local', () => {
    const hours = daily('06:00-10:00');
    expect(isOpen(hours, NY, z('2026-03-08T09:59:00Z'))).toBe(false);
    expect(isOpen(hours, NY, z('2026-03-08T10:00:00Z'))).toBe(true);
    expect(iso(closesAt([hours], NY, z('2026-03-08T10:00:00Z')))).toBe('2026-03-08T14:00:00.000Z');
  });
  it('New York spring: a span starting in the gap opens when the gap ends', () => {
    const hours = daily('02:30-04:00');
    expect(isOpen(hours, NY, z('2026-03-08T06:59:00Z'))).toBe(false);
    expect(iso(nextOpen([hours], NY, z('2026-03-08T06:59:00Z')))).toBe('2026-03-08T07:00:00.000Z');
    expect(isOpen(hours, NY, z('2026-03-08T07:00:00Z'))).toBe(true);
  });
  it('New York autumn: the repeated hour is open both times', () => {
    const hours = daily('01:00-02:00');
    expect(isOpen(hours, NY, z('2026-11-01T05:30:00Z'))).toBe(true);
    expect(isOpen(hours, NY, z('2026-11-01T06:30:00Z'))).toBe(true);
    expect(isOpen(hours, NY, z('2026-11-01T07:00:00Z'))).toBe(false);
    expect(iso(closesAt([hours], NY, z('2026-11-01T05:30:00Z')))).toBe('2026-11-01T07:00:00.000Z');
  });
  it('New York autumn: a span ending in the repeat reopens at the second pass', () => {
    const hours = daily('00:00-01:30');
    expect(isOpen(hours, NY, z('2026-11-01T05:30:00Z'))).toBe(false);
    expect(iso(nextOpen([hours], NY, z('2026-11-01T05:30:00Z')))).toBe('2026-11-01T06:00:00.000Z');
  });
  it('London spring: a span inside the gap does not open that day', () => {
    const hours = daily('01:00-02:00');
    expect(isOpen(hours, LON, z('2026-03-29T01:00:00Z'))).toBe(false);
    expect(iso(nextOpen([hours], LON, z('2026-03-29T00:30:00Z') + 31 * 60_000))).toBe(
      '2026-03-30T00:00:00.000Z',
    );
  });
  it('London autumn: the repeated hour is open twice', () => {
    const hours = daily('01:00-02:00');
    expect(isOpen(hours, LON, z('2026-10-25T00:30:00Z'))).toBe(true);
    expect(isOpen(hours, LON, z('2026-10-25T01:30:00Z'))).toBe(true);
    expect(isOpen(hours, LON, z('2026-10-25T02:00:00Z'))).toBe(false);
  });
  it('Kolkata keeps its half hour', () => {
    const hours = daily('06:00-10:00');
    expect(isOpen(hours, 'Asia/Kolkata', z('2026-07-05T00:29:00Z'))).toBe(false);
    expect(isOpen(hours, 'Asia/Kolkata', z('2026-07-05T00:30:00Z'))).toBe(true);
  });
  it('Lord Howe: a 30 minute shift moves the local clock, not the span', () => {
    const hours = daily('06:00-10:00');
    const tz = 'Australia/Lord_Howe';
    expect(isOpen(hours, tz, z('2026-10-03T19:00:00Z'))).toBe(true);
    expect(iso(closesAt([hours], tz, z('2026-10-03T19:00:00Z')))).toBe('2026-10-03T23:00:00.000Z');
  });
});
