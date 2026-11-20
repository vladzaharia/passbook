import { describe, expect, it } from 'vitest';
import { formatWhen } from './when.ts';

const AT = '2030-06-01T19:00:00-07:00';

describe('formatWhen', () => {
  it('reads the pass wall clock in English, with no zone conversion', () => {
    expect(formatWhen(AT)).toBe('Sat, Jun 1, 2030, 7:00 PM');
    expect(formatWhen(AT, 'PKDateStyleMedium', 'PKDateStyleShort')).toBe('Jun 1, 2030, 7:00 PM');
    expect(formatWhen(AT, 'PKDateStyleFull', 'PKDateStyleNone')).toBe('Saturday, June 1, 2030');
    expect(formatWhen(AT, 'PKDateStyleNone', 'PKDateStyleLong')).toBe('7:00 PM GMT-7');
    expect(formatWhen(AT, 'PKDateStyleShort')).toBe('6/1/30');
  });

  it('handles midnight, noon, UTC and half-hour offsets, and a bare date', () => {
    expect(formatWhen('2030-06-01T00:05:00Z', undefined, 'PKDateStyleLong')).toBe('12:05 AM UTC');
    expect(formatWhen('2030-06-01T12:00:00+05:30', undefined, 'PKDateStyleFull')).toBe(
      '12:00 PM GMT+5:30',
    );
    expect(formatWhen('2030-06-01', 'PKDateStyleMedium', 'PKDateStyleShort')).toBe('Jun 1, 2030');
  });

  it('returns text that is not a date unchanged', () => {
    expect(formatWhen('Doors at six')).toBe('Doors at six');
  });
});
