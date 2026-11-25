import { describe, expect, it } from 'vitest';
import { isIpOrCidr, splitIps } from './cidr.ts';

describe('isIpOrCidr', () => {
  it.each([
    '203.0.113.7',
    '203.0.113.0/24',
    '10.0.0.0/8',
    '::1',
    '2001:db8::/32',
    '2001:db8:0:0:0:0:0:1',
  ])('accepts %s', (v) => expect(isIpOrCidr(v)).toBe(true));
  it.each([
    '',
    'abc',
    '256.1.1.1',
    '1.2.3.4/33',
    '1.2.3',
    '2001:db8::/129',
    '1::2::3',
    'g::1',
    '1.2.3.4/24/1',
  ])('rejects %s', (v) => expect(isIpOrCidr(v)).toBe(false));
  it('splits on spaces and commas', () => {
    expect(splitIps('1.1.1.1, 2.2.2.2\n3.3.3.3 ')).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });
});
