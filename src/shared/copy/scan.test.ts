import { describe, expect, it } from 'vitest';
import { ScanReasonSchema } from '../contracts/scan.ts';
import { OVERRIDE_NOTES } from '../contracts/scan-occupancy.ts';
import {
  SCAN_COPY,
  SCAN_COUNTER_COPY,
  SCAN_OCCUPANCY_COPY,
  SCAN_REASON_COPY,
  SCAN_REASON_VARIANTS,
  scanLine,
} from './scan.ts';

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
    const allowed = new Set(['plan', 'zone', 'when', 'time', 'limit', 'used']);
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
    expect(SCAN_COPY.verdict.access.headline).toBe('Checked in');
  });

  it('has occupancy reasons with one default line each', () => {
    expect(SCAN_REASON_COPY.still_inside).toEqual({
      headline: 'Already in',
      sub: 'Since {time} · {scanner}. Check ID.',
    });
    expect(SCAN_REASON_COPY.not_inside).toEqual({
      headline: 'Not tapped in',
      sub: 'No entry recorded. Tap them in first.',
    });
    expect(SCAN_REASON_COPY.capacity_full.headline).toBe('{place} full');
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
    expect(scanLine(SCAN_REASON_COPY.wrong_event.sub, { event: 'Gala', day: 'Sat' })).toBe(
      'This scanner is for Gala, Sat.',
    );
  });

  it('has the occupancy words, terse and without a trailing filler', () => {
    expect(SCAN_COPY.verdict.checkedOut).toBe('Checked out');
    expect(SCAN_COPY.actions).toMatchObject({
      tapIn: 'Tap in',
      tapOut: 'Tap out',
      checkOut: 'Check out',
      markAsOut: 'Mark as out',
      letIn: 'Let in',
      signInToAct: 'Sign in to act',
    });
    expect(SCAN_OCCUPANCY_COPY.zoneFull?.headline).toBe('{zone} full');
    expect(SCAN_OCCUPANCY_COPY.parentNotIn?.sub).toBe('Tap in at {zone} first.');
    for (const note of OVERRIDE_NOTES)
      expect(SCAN_COPY.overrideNotes[note].length).toBeGreaterThan(0);
  });

  it('every line fills with the placeholders it names', () => {
    const lines = [
      ...Object.values(SCAN_OCCUPANCY_COPY).flatMap((l) => [l.headline, l.sub]),
      ...Object.values(SCAN_COPY.managerCode),
      SCAN_COPY.verdict.tappedOutSub,
      SCAN_COPY.verdict.letInBy,
      SCAN_COPY.verdict.overrideTaken,
    ];
    for (const line of lines)
      expect(
        scanLine(line, {
          n: 4,
          wait: '5 min',
          zone: 'Pool',
          staff: 'Ana',
          stay: '1 h',
          in: 1,
          capacity: 2,
          ago: 'now',
          scanner: 'D',
          time: '9',
          action: 'Redeem',
        }),
      ).not.toMatch(/\{\w+\}/);
  });
});

describe('SCAN_COUNTER_COPY', () => {
  it('words a counter refusal beside, not over, the balance and stamp lines', () => {
    expect(SCAN_COUNTER_COPY.no_balance?.headline).toBe('None left');
    expect(`${SCAN_COUNTER_COPY.card_full?.headline}. ${SCAN_COUNTER_COPY.card_full?.sub}`).toBe(
      'Already full. Use some first.',
    );
    expect(SCAN_REASON_COPY.no_balance.headline).toBe('Not enough balance');
    expect(SCAN_REASON_COPY.card_full.headline).toBe('Card is full');
  });
  it('has a headline and a sub for each reason it words', () => {
    for (const line of Object.values(SCAN_COUNTER_COPY)) {
      expect(line.headline.length).toBeGreaterThan(0);
      expect(line.sub.length).toBeGreaterThan(0);
    }
  });
});
