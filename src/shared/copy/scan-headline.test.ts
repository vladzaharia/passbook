import { describe, expect, it } from 'vitest';
import { SCAN_REASON_COPY } from './scan.ts';
import { reasonHeadline } from './scan-headline.ts';

describe('reasonHeadline', () => {
  it('leaves no marker unfilled for any reason, with or without facts', () => {
    for (const reason of Object.keys(SCAN_REASON_COPY)) {
      expect(reasonHeadline(reason), reason).not.toMatch(/[{}]/);
      expect(reasonHeadline(reason, { place: 'Gala', action: 'Check in' }), reason).not.toMatch(
        /[{}]/,
      );
    }
  });

  it('names what was already done', () => {
    expect(reasonHeadline('already_done', { actionKind: 'check_in' })).toBe('Already checked in');
    expect(reasonHeadline('already_done', { actionKind: 'add' })).toBe('Already done');
  });

  it('names the place, or drops it when unknown', () => {
    expect(reasonHeadline('ended', { place: 'Gala' })).toBe('Gala ended');
    expect(reasonHeadline('ended')).toBe('Ended');
    expect(reasonHeadline('capacity_full', { place: 'Gym' })).toBe('Gym full');
    expect(reasonHeadline('capacity_full', { place: null })).toBe('Full');
  });

  it('keeps an unknown code as is', () => {
    expect(reasonHeadline('retired_reason')).toBe('retired_reason');
  });
});
