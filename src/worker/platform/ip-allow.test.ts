import { describe, expect, it } from 'vitest';
import { ipAllowed, parseCidr } from './ip-allow.ts';

describe('ip allowlist', () => {
  it('matches an address, a v4 range and a v6 range', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
    expect(ipAllowed('203.0.113.200', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('10.0.0.1', ['0.0.0.0/0'])).toBe(true);
  });

  it('reads an IPv4-mapped IPv6 address as IPv4, and never crosses families', () => {
    expect(ipAllowed('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.113.7', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
  });

  it('matches nothing for an address it cannot read, or an empty list', () => {
    for (const ip of [undefined, '', 'unknown', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5'])
      expect(ipAllowed(ip, ['0.0.0.0/0', '::/0'])).toBe(false);
    expect(ipAllowed('203.0.113.7', [])).toBe(false);
  });

  it('ignores a malformed entry rather than allowing everything', () => {
    expect(ipAllowed('203.0.113.7', ['garbage', '203.0.113.7/99'])).toBe(false);
  });

  it('parses only well-formed ranges whose host bits are zero', () => {
    for (const ok of ['203.0.113.0/24', '203.0.113.7', '2001:db8::/32', '::1', '0.0.0.0/0'])
      expect(parseCidr(ok), ok).not.toBeNull();
    for (const bad of [
      '203.0.113.7/24',
      '203.0.113.0/33',
      '2001:db8::/129',
      '1.2.3/24',
      '1.2.3.4/x',
      '1.2.3.4/24/1',
      '/24',
      '',
      '256.0.0.0',
    ])
      expect(parseCidr(bad), bad).toBeNull();
  });
});
