import { describe, expect, it } from 'vitest';
import { ScanReasonSchema } from '../contracts/scan.ts';
import { SCAN_COPY, SCAN_REASON_COPY, SCAN_REASON_VARIANTS, scanLine } from './scan.ts';

const CLIENT = [
  'network',
  'timeout',
  'unconfirmed',
  'still_unconfirmed',
  'server',
  'rate_limited',
  'saved_offline',
  'add_link',
] as const;

describe('SCAN_COPY', () => {
  it.each([...ScanReasonSchema.options, ...CLIENT])('has a headline and a sub for %s', (reason) => {
    const line = SCAN_REASON_COPY[reason];
    expect(line.headline.length).toBeGreaterThan(0);
    expect(line.sub.length).toBeGreaterThan(0);
  });

  it('the access reasons name only plan, zone, when, time and limit', () => {
    const allowed = new Set(['plan', 'zone', 'when', 'time', 'limit']);
    const lines = [
      ...(
        [
          'zone_not_included',
          'outside_hours',
          'guest_expired',
          'guest_visits_used',
          'suspended',
        ] as const
      ).map((r) => SCAN_REASON_COPY[r].sub),
      SCAN_COPY.verdict.access.sub,
      SCAN_REASON_VARIANTS.outside_hours.noHours,
      SCAN_REASON_VARIANTS.zone_not_included.noZone,
    ];
    for (const line of lines)
      for (const [, key] of line.matchAll(/\{(\w+)\}/g)) expect(allowed).toContain(key);
    expect(SCAN_COPY.verdict.access.headline).toBe('Access granted');
  });

  it('has occupancy reasons with one default line each', () => {
    expect(SCAN_REASON_COPY.still_inside).toEqual({
      headline: 'Already in',
      sub: 'Since {time} · {scanner}',
    });
    expect(SCAN_REASON_COPY.not_inside).toEqual({
      headline: 'Not tapped in',
      sub: 'No entry recorded.',
    });
    expect(SCAN_REASON_COPY.capacity_full.headline).toBe('Event full');
  });

  it('says what a screen is when it calls a scan route', () => {
    expect(SCAN_COPY.boot.screenOnlyTitle).toBe('This device is a screen.');
    expect(SCAN_COPY.boot.screenOnlyLine).toBe('Ask an admin to change it.');
  });

  it('has the display captions of DM 3.5', () => {
    expect(SCAN_COPY.display.moreFor).toBe('{n} more for {reward}');
    expect(SCAN_COPY.display.changedElsewhere).toBe('Changed elsewhere');
    expect(SCAN_COPY.display.noPhoto).toBe('No photo');
    expect(SCAN_COPY.display.lowBalance).toBe('Low balance');
    expect(SCAN_COPY.display.noVisits).toBe('No visits yet.');
    expect(SCAN_COPY.display.cutOnThisScreen).toBe('Cut on this screen');
  });

  it('fills markers and leaves a missing one visible', () => {
    expect(scanLine(SCAN_REASON_COPY.rate_limited.sub, { seconds: 20 })).toBe('Try again in 20 s.');
    expect(scanLine(SCAN_REASON_COPY.wrong_event.sub)).toBe('For {event}.');
  });
});
