import { describe, expect, it } from 'vitest';
import { addDays, dayRange, localDate, startOfDay, zonedInstant } from './zoned.ts';

const iso = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(ms);
const H = 3_600_000;

describe('zonedInstant', () => {
  it.each([
    ['Europe/London', '2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'],
    ['America/New_York', '2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01'],
    ['Australia/Lord_Howe', '2026-04-04', '2026-04-05', '2026-10-03', '2026-10-04'],
  ])('keeps 10:00 local across both changes in %s', (tz, a, b, c, d) => {
    for (const day of [a, b, c, d])
      expect(iso(zonedInstant(day, '10:00', tz), tz)).toBe(`${day} 10:00:00`);
  });

  it('keeps Kolkata fixed at +5:30', () => {
    expect(zonedInstant('2026-06-01', '10:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 5, 1, 4, 30));
  });

  it('moves a time in the spring-forward gap to the first valid instant', () => {
    expect(iso(zonedInstant('2026-03-29', '01:30', 'Europe/London'), 'Europe/London')).toBe(
      '2026-03-29 02:00:00',
    );
    expect(iso(zonedInstant('2026-03-08', '02:30', 'America/New_York'), 'America/New_York')).toBe(
      '2026-03-08 03:00:00',
    );
    // Lord Howe skips 02:00-02:30 on 2026-10-04.
    expect(
      iso(zonedInstant('2026-10-04', '02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe'),
    ).toBe('2026-10-04 02:30:00');
  });

  it('takes the earlier instant when fall-back repeats a time', () => {
    // New York 01:30 on 2026-11-01 is EDT (UTC-4) first.
    expect(zonedInstant('2026-11-01', '01:30', 'America/New_York')).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
    expect(zonedInstant('2026-10-25', '01:30', 'Europe/London')).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
});

describe('startOfDay and dayRange', () => {
  it('is 23 h on spring-forward and 25 h on fall-back days', () => {
    const [a, b] = dayRange('2026-03-08', 'America/New_York');
    expect((b - a) / H).toBe(23);
    const [c, d] = dayRange('2026-11-01', 'America/New_York');
    expect((d - c) / H).toBe(25);
    const [e, f] = dayRange('2026-10-25', 'Europe/London');
    expect((f - e) / H).toBe(25);
    const [g, h] = dayRange('2026-10-04', 'Australia/Lord_Howe');
    expect((h - g) / H).toBe(23.5);
  });

  it('handles a midnight gap in Santiago', () => {
    // Chile moves 00:00 to 01:00 on 2026-09-06.
    const t = startOfDay('2026-09-06', 'America/Santiago');
    expect(iso(t, 'America/Santiago')).toBe('2026-09-06 01:00:00');
    expect(localDate(t - 1, 'America/Santiago')).toBe('2026-09-05');
    expect(localDate(t, 'America/Santiago')).toBe('2026-09-06');
  });
});

describe('localDate and addDays', () => {
  it('reads the zone date', () => {
    const t = Date.UTC(2026, 0, 31, 23, 30);
    expect(localDate(t, 'Europe/Berlin')).toBe('2026-02-01');
    expect(localDate(t, 'America/New_York')).toBe('2026-01-31');
  });
  it('adds calendar days across month, year and leap ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-29', 7)).toBe('2026-04-05');
  });
});
