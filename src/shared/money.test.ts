import { describe, expect, it } from 'vitest';
import { fromMinor, minorDigits, parseMoney, toMinor } from './money.ts';

describe('money', () => {
  it('knows the minor digits of a currency', () => {
    expect([minorDigits('USD'), minorDigits('JPY'), minorDigits('BHD')]).toEqual([2, 0, 3]);
    expect([minorDigits(null), minorDigits('nope')]).toEqual([2, 2]);
  });

  it('counts exactly in minor units', () => {
    expect(toMinor(10.1, 2)).toBe(1010);
    expect(toMinor(4.5, 2)).toBe(450);
    expect(fromMinor(1010 - 450, 2)).toBe(5.6);
    expect(toMinor(1.005, 2)).toBeNull();
    expect(toMinor(2.5, 0)).toBeNull();
  });

  it('parses typed text and refuses extra digits', () => {
    expect(parseMoney('4.5', 2)).toEqual({ minor: 450 });
    expect(parseMoney('4,50', 2)).toEqual({ minor: 450 });
    expect(parseMoney('.5', 2)).toEqual({ minor: 50 });
    expect(parseMoney('4.505', 2)).toEqual({ error: 'digits' });
    expect(parseMoney('4.5', 0)).toEqual({ error: 'digits' });
    expect(parseMoney('500', 0)).toEqual({ minor: 500 });
    expect(parseMoney('', 2)).toEqual({ error: 'format' });
    expect(parseMoney('4a', 2)).toEqual({ error: 'format' });
    expect(parseMoney('-1', 2)).toEqual({ error: 'format' });
  });
});
