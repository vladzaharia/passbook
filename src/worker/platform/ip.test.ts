import { describe, expect, it } from 'vitest';
import { ipBucket, ipPrefix, ipRatePrefix } from './ip.ts';

describe('ip prefixes', () => {
  it('normalizes v6 before taking the prefix', () => {
    const forms = [
      '2001:db8:1:2::1',
      '2001:0DB8:0001:0002:0000:0000:0000:0001',
      '2001:DB8:1:2:0:0:0:1',
    ];
    expect(new Set(forms.map(ipPrefix)).size).toBe(1);
    expect(ipPrefix('2001:db8:1:2::1')).toBe('2001:0db8:0001::/48');
    expect(ipPrefix('::1')).toBe('0000:0000:0000::/48');
  });

  it('groups a /64 and keeps v4 at /24', () => {
    expect(ipRatePrefix('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(ipRatePrefix('2001:DB8:1:2::9'));
    expect(ipRatePrefix('2001:db8:1:3::1')).not.toBe(ipRatePrefix('2001:db8:1:2::1'));
    expect(ipRatePrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
  });

  it('handles mapped v4, junk and missing', () => {
    expect(ipRatePrefix('::ffff:203.0.113.5')).toBe('203.0.113.0/24');
    expect(ipRatePrefix('zz::1')).toBeNull();
    expect(ipRatePrefix('1::2::3')).toBeNull();
    expect(ipRatePrefix('unknown')).toBeNull();
    expect(ipRatePrefix(undefined)).toBeNull();
  });
});

describe('ipBucket', () => {
  it('keeps the whole IPv4 address and takes the /64 of IPv6', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipRatePrefix('2001:db8:1:2::9'));
    expect(ipBucket('unknown')).toBeNull();
    expect(ipBucket('not-an-ip')).toBeNull();
    expect(ipBucket(undefined)).toBeNull();
  });
});

describe('ipBucket', () => {
  it('keeps the whole IPv4 address and takes the /64 of IPv6', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipRatePrefix('2001:db8:1:2::9'));
    expect(ipBucket('unknown')).toBeNull();
    expect(ipBucket('not-an-ip')).toBeNull();
    expect(ipBucket(undefined)).toBeNull();
  });
});
