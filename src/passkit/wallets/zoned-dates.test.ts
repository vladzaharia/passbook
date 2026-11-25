import { describe, expect, it } from 'vitest';
import { withZone } from './zoned-dates.ts';

describe('withZone', () => {
  it('gives a date-time with no offset the org zone offset, across a DST change', () => {
    expect(withZone('2030-01-15T19:00', 'America/Los_Angeles')).toBe('2030-01-15T19:00:00-08:00');
    expect(withZone('2030-07-15T19:00:30', 'America/Los_Angeles')).toBe(
      '2030-07-15T19:00:30-07:00',
    );
    expect(withZone('2030-07-15T19:00', 'Asia/Kolkata')).toBe('2030-07-15T19:00:00+05:30');
  });

  it('leaves Z, written offsets, bare dates and text alone, at any depth', () => {
    const value = {
      a: '2030-01-15T19:00:00Z',
      b: ['2030-01-15T19:00:00+02:00', '2030-01-15', 'Doors at 7'],
      c: { d: '2030-01-15T19:00' },
      n: 3,
    };
    expect(withZone(value, 'America/Los_Angeles')).toEqual({
      ...value,
      c: { d: '2030-01-15T19:00:00-08:00' },
    });
  });
});
