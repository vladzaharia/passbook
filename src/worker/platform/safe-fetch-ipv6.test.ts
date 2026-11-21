import { expect, it } from 'vitest';
import { assertSafeUrl, isPrivateIp } from './safe-fetch.ts';

it('refuses private and special IPv6 and IPv4 forms', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    'fe80::1',
    'fd00::1',
    '2002:7f00:1::',
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    'fec0::1',
  ])
    expect([ip, isPrivateIp(ip)]).toEqual([ip, true]);
});

it('allows a public IPv4-translated address', () => {
  expect(isPrivateIp('::ffff:0:808:808')).toBe(false);
});

it('refuses host forms that normalise to private or platform hosts', () => {
  for (const raw of [
    'https://0x7f000001/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://127.1/',
    'https://[::1]/',
    'https://localhost./',
    'https://passbook.mobile./',
    'https://PASSBOOK.mobile%2e/',
    'https://x.passbook.mobile/',
    'https://passbook。mobile/',
    'https://wallet.plrs.im../',
    'https://a.workers.dev/',
    'https://foo.internal/',
    'https://h.example:8443/',
    'http://h.example/',
    'https://u:p@h.example/',
  ])
    expect(() => assertSafeUrl(raw, ['passbook.mobile', 'plrs.im', 'workers.dev'])).toThrow();
});
