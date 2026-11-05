import { describe, expect, it } from 'vitest';
import { ScanReasonSchema } from '../contracts/scan.ts';
import { SCAN_COPY, SCAN_REASON_COPY, scanLine } from './scan.ts';

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
