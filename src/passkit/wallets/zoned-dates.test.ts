import { describe, expect, it } from 'vitest';
import { zonedInput, zonedPass } from './zoned-dates.ts';

const LA = 'America/Los_Angeles';

describe('zonedPass', () => {
  it('gives an offsetless date-time the org zone offset, across a DST change', () => {
    const at = (v: string) => zonedPass({ expirationDate: v }, LA).expirationDate;
    expect(at('2030-01-15T19:00')).toBe('2030-01-15T19:00:00-08:00');
    expect(at('2030-07-15T19:00:30')).toBe('2030-07-15T19:00:30-07:00');
    expect(zonedPass({ expirationDate: '2030-07-15T19:00' }, 'Asia/Kolkata').expirationDate).toBe(
      '2030-07-15T19:00:00+05:30',
    );
  });

  it('reads only the places that hold a date', () => {
    const pass = {
      expirationDate: '2030-01-15T19:00:00Z',
      relevantDates: [{ startDate: '2030-01-15T19:00' }],
      semantics: { eventStartDate: '2030-01-15T19:00', seatSection: '2030-01-15T19:00' },
      eventTicket: {
        primaryFields: [
          { key: 'when', value: '2030-01-15T19:00', timeStyle: 'PKDateStyleShort' },
          { key: 'note', value: '2030-01-15T19:00' },
        ],
      },
    };
    const out = zonedPass(pass, LA);
    expect(out.expirationDate).toBe('2030-01-15T19:00:00Z');
    expect(out.relevantDates[0]?.startDate).toBe('2030-01-15T19:00:00-08:00');
    expect(out.semantics.eventStartDate).toBe('2030-01-15T19:00:00-08:00');
    expect(out.semantics.seatSection).toBe('2030-01-15T19:00');
    expect(out.eventTicket.primaryFields.map((f) => f.value)).toEqual([
      '2030-01-15T19:00:00-08:00',
      '2030-01-15T19:00',
    ]);
  });
});

describe('zonedInput', () => {
  it('reads only the date-time inputs, not free text', () => {
    const input = { starts: '2030-01-15T19:00', note: '2030-01-15T19:00' };
    expect(zonedInput(input, new Set(['starts']), LA)).toEqual({
      starts: '2030-01-15T19:00:00-08:00',
      note: '2030-01-15T19:00',
    });
  });
});
