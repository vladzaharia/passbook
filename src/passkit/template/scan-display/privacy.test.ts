import { describe, expect, it } from 'vitest';
import {
  HIDDEN_STOP_LABEL,
  hasContactShape,
  isPrivateName,
  leaksSecret,
  SECRET_MIN_LENGTH,
  secretSpellings,
} from './privacy.ts';

describe('isPrivateName', () => {
  it.each([
    'email',
    'wifiPassword',
    'guest_pin',
    'scanCode',
    'serialNumber',
    'webServiceURL',
    'barcodes',
    'contactName',
    'nfcKey',
    'billingAddress',
    '__proto__',
    'constructor',
  ])('hides %s', (name) => expect(isPrivateName(name)).toBe(true));

  it.each(['memberName', 'seat', 'tier', 'Renamed entry', 'order', 'publicLabel', 'pinned'])(
    'keeps %s',
    (name) => expect(isPrivateName(name)).toBe(false),
  );
});

describe('secretSpellings and leaksSecret', () => {
  it('skips anything shorter than the minimum, so ordinary words are never denied', () => {
    expect(SECRET_MIN_LENGTH).toBe(6);
    expect(secretSpellings('gold', 'abcde', 12345, true, null)).toEqual([]);
    expect(secretSpellings('abcdef')).toEqual(['abcdef']);
  });

  it('walks nested values and adds the escaped and encoded spellings', () => {
    const spellings = secretSpellings({ a: ['tok&<en>-1'], b: 918273 });
    expect(spellings).toContain('tok&<en>-1');
    expect(spellings).toContain('tok&amp;&lt;en&gt;-1');
    expect(spellings).toContain(encodeURIComponent('tok&<en>-1'));
    expect(spellings).toContain('918273');
  });

  it('matches text containing a secret, and a number that is one', () => {
    const spellings = secretSpellings('scan-private-6294', 918273);
    expect(leaksSecret('code scan-private-6294 here', spellings)).toBe(true);
    expect(leaksSecret(918273, spellings)).toBe(true);
    expect(leaksSecret('scan-private', spellings)).toBe(false);
    expect(leaksSecret(918274, spellings)).toBe(false);
    expect(leaksSecret(true, spellings)).toBe(false);
  });

  it('survives a lone surrogate', () => {
    expect(() => secretSpellings('bad-\uD800-surrogate')).not.toThrow();
  });
});

describe('hasContactShape', () => {
  it.each([
    'ada@example.com',
    'https://example.com/x',
    'mailto:ada',
    'tel:+4479',
    'www.example.com',
  ])('flags %s', (text) => expect(hasContactShape(text)).toBe(true));

  // The old filter hid any text with seven or more digits and separators.
  it.each([
    'Order 20261105 0042',
    '01a1cb28-5eef-7134-8435-08a2d8a1361f',
    '2026-11-05T18:00',
    '+44 7911 123456',
    'Seat 12, row 4 @ gate',
  ])('does not guess that %s is contact data', (text) => expect(hasContactShape(text)).toBe(false));
});

it('names a generic label for a hidden stop flag', () => {
  expect(HIDDEN_STOP_LABEL).toBe('Check required');
});
