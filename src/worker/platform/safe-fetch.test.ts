import { describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  createSafeFetch,
  isIpLiteral,
  isPrivateIp,
  platformHostsOf,
} from './safe-fetch.ts';

describe('assertSafeUrl', () => {
  it.each([
    'http://example.com/x',
    'https://example.com:8443/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://2130706433/x',
    'https://localhost/x',
    'https://intranet/x',
    'https://printer.local/x',
    'https://user:pw@example.com/x',
    'https://passbook.mobile/api',
    'https://sub.passbook.mobile/api',
    'https://example.com/a/../b',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertSafeUrl(url, ['passbook.mobile'])).toThrow();
  });

  it('accepts public https URLs', () => {
    expect(assertSafeUrl('https://api.example.com/v1/members/42?x=1').hostname).toBe(
      'api.example.com',
    );
    expect(assertSafeUrl('https://api.example.com:443/v1').port).toBe('');
  });
});

describe('platformHostsOf', () => {
  const env = {
    PUBLIC_BASE_URL: 'https://passbook.mobile',
    OIDC_ISSUER: 'https://id.plrs.im',
    SSRF_DENY_HOSTS: 'plrs.im',
  };
  it('lists the base, issuer, workers.dev and the deny list', () => {
    expect(platformHostsOf(env).sort()).toEqual(
      ['id.plrs.im', 'passbook.mobile', 'plrs.im', 'workers.dev'].sort(),
    );
  });
  it('adds the hosts that only redirect to the base', () => {
    const moved = {
      ...env,
      PUBLIC_BASE_URL: 'https://passbook.mobile',
      REDIRECT_HOSTS: 'old.example',
    };
    expect(platformHostsOf(moved)).toEqual(
      expect.arrayContaining(['passbook.mobile', 'old.example']),
    );
    expect(() => assertSafeUrl('https://old.example/x', platformHostsOf(moved))).toThrow();
  });
  it.each(['https://id.plrs.im/api', 'https://other.plrs.im/x', 'https://plrs.im/'])(
    'refuses %s',
    (url) => {
      expect(() => assertSafeUrl(url, platformHostsOf(env))).toThrow(/not allowed/);
    },
  );
});

describe('ip classification', () => {
  it.each([
    '10.0.0.1',
    '192.0.2.4',
    '198.51.100.7',
    '203.0.113.9',
    '192.88.99.1',
    '127.0.0.1',
    '172.16.5.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '2002:7f00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001::1',
    '64:ff9b:1::a00:1',
    '100::1',
    '224.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('%s is public', (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
  it('detects ip literals', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('createSafeFetch', () => {
  const publicDns = { resolve: async () => ['93.184.216.34'] };
  const respond = (body: BodyInit | null, init?: ResponseInit) =>
    (async () => new Response(body, init)) as unknown as typeof fetch;

  it('fetches and parses json', async () => {
    const safe = createSafeFetch({
      resolver: publicDns,
      fetchImpl: respond('{"a":1}', { status: 200 }),
    });
    const res = await safe('https://api.example.com/x');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ a: 1 });
  });

  it('refuses hosts that resolve to private addresses or nowhere', async () => {
    const privateDns = { resolve: async () => ['10.0.0.5'] };
    await expect(
      createSafeFetch({ resolver: privateDns, fetchImpl: respond('x') })('https://api.example.com'),
    ).rejects.toThrow(/private/);
    await expect(
      createSafeFetch({ resolver: { resolve: async () => [] }, fetchImpl: respond('x') })(
        'https://api.example.com',
      ),
    ).rejects.toThrow(/resolve/);
  });

  it('never follows redirects', async () => {
    let redirect: RequestInit['redirect'];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } });
    }) as unknown as typeof fetch;
    await expect(
      createSafeFetch({ resolver: publicDns, fetchImpl })('https://api.example.com'),
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(redirect).toBe('manual');
  });

  it('caps the body size', async () => {
    const safe = createSafeFetch({
      resolver: publicDns,
      fetchImpl: respond('x'.repeat(1000)),
      maxBytes: 100,
    });
    await expect(safe('https://api.example.com')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('times out', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const safe = createSafeFetch({ resolver: publicDns, fetchImpl, timeoutMs: 20 });
    await expect(safe('https://api.example.com')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('does not echo upstream bodies in errors', async () => {
    const fetchImpl = (async () =>
      new Response('secret upstream body', { status: 302 })) as unknown as typeof fetch;
    const error = await createSafeFetch({ resolver: publicDns, fetchImpl })(
      'https://api.example.com',
    ).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('secret');
  });
});
