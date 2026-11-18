import { describe, expect, it } from 'vitest';
import { humanize, micros, moduleId, rfc3339, utc } from './values.ts';

describe('values', () => {
  it('writes an Apple date as RFC 3339 and keeps its offset', () => {
    expect(rfc3339('2030-06-01T19:00-07:00')).toBe('2030-06-01T19:00:00-07:00');
    expect(rfc3339('2030-06-01T19:00:00-0700')).toBe('2030-06-01T19:00:00-07:00');
    expect(rfc3339('2030-06-01')).toBe('2030-06-01T00:00:00');
    expect(rfc3339('2030-06-01T19:00:00.5z')).toBe('2030-06-01T19:00:00.5Z');
    expect(rfc3339('next week')).toBeUndefined();
  });

  it('puts the interval bounds in UTC, reading a bare date as UTC', () => {
    expect(utc('2030-06-01T16:30:00-04:00')).toBe('2030-06-01T20:30:00Z');
    expect(utc('2030-06-01T13:15:00Z')).toBe('2030-06-01T13:15:00Z');
    expect(utc('2030-06-01')).toBe('2030-06-01T00:00:00Z');
    expect(utc('soon')).toBeUndefined();
  });

  it('converts an amount to millionths exactly', () => {
    expect(micros('25')).toBe('25000000');
    expect(micros('12.5')).toBe('12500000');
    expect(micros('0.000001')).toBe('1');
    expect(micros('-3.20')).toBe('-3200000');
    expect(micros('1.23456789')).toBe('1234567');
    expect(micros('9007199254740993.5')).toBe('9007199254740993500000');
    expect(micros('12 USD')).toBeUndefined();
  });

  it('names keys and ids', () => {
    expect(humanize('contactVenueWebsite')).toBe('Contact venue website');
    expect(humanize('orderFoodURL')).toBe('Order food');
    expect(moduleId('backFields.pass service')).toBe('backFields.pass_service');
  });
});
