import { afterEach, describe, expect, it } from 'vitest';
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

describe('trailing-dot hosts', () => {
  const hosts = ['wallet.plrs.im', 'plrs.im'];
  it.each([
    'https://wallet.plrs.im./api',
    'https://WALLET.PLRS.IM../api',
    'https://sub.plrs.im./x',
    'https://x.local./a',
    'https://metadata.google.internal./computeMetadata/v1/',
    'https://intranet./x',
    'https://printer.localhost./x',
  ])('refuses %s', (url) => {
    expect(() => assertSafeUrl(url, hosts)).toThrow();
  });

  it('refuses a redirect hop to one, without fetching it', async () => {
    for (const to of [
      'https://wallet.plrs.im./x',
      'https://x.local./a',
      'https://metadata.google.internal./v1',
    ]) {
      const seen: string[] = [];
      const fetchImpl = (async (url: string) => {
        seen.push(url);
        return new Response(null, { status: 302, headers: { location: to } });
      }) as unknown as typeof fetch;
      await expect(
        createSafeFetch({
          resolver: { resolve: async () => ['93.184.216.34'] },
          fetchImpl,
          maxRedirects: 3,
          platformHosts: hosts,
        })('https://a.example.com/'),
      ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
      expect(seen).toEqual(['https://a.example.com/']);
    }
  });

  it('answers a malformed Location as a blocked redirect', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://[bad' },
      })) as unknown as typeof fetch;
    await expect(
      createSafeFetch({
        resolver: { resolve: async () => ['93.184.216.34'] },
        fetchImpl,
        maxRedirects: 3,
      })('https://a.example.com/'),
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
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

  describe('redirects', () => {
    const hop = (to: string, status = 302) =>
      new Response(null, { status, headers: { location: to } });
    /** Serves each URL from a table and records what was asked. */
    const site = (
      table: Record<string, () => Response>,
      seen: { url: string; headers: Headers }[] = [],
    ) =>
      (async (url: string, init?: RequestInit) => {
        seen.push({ url, headers: new Headers(init?.headers) });
        const make = table[url];
        return make ? make() : new Response('missing', { status: 404 });
      }) as unknown as typeof fetch;

    it('follows a hop to another public host, within the hop cap', async () => {
      const seen: { url: string; headers: Headers }[] = [];
      const fetchImpl = site(
        {
          'https://docs.example.com/pub': () => hop('https://doc-0k-sheets.example.net/export'),
          'https://doc-0k-sheets.example.net/export': () => new Response('a,b', { status: 200 }),
        },
        seen,
      );
      const res = await createSafeFetch({ resolver: publicDns, fetchImpl, maxRedirects: 3 })(
        'https://docs.example.com/pub',
      );
      expect(res.text()).toBe('a,b');
      expect(seen.map((s) => s.url)).toEqual([
        'https://docs.example.com/pub',
        'https://doc-0k-sheets.example.net/export',
      ]);
    });

    it('refuses a hop to a host that resolves privately', async () => {
      const dns = {
        resolve: async (host: string) =>
          host === 'evil.example.net' ? ['10.0.0.9'] : ['93.184.216.34'],
      };
      const fetchImpl = site({
        'https://docs.example.com/pub': () => hop('https://evil.example.net/x'),
      });
      await expect(
        createSafeFetch({ resolver: dns, fetchImpl, maxRedirects: 3 })(
          'https://docs.example.com/pub',
        ),
      ).rejects.toThrow(/private/);
    });

    it.each([
      ['http', 'http://docs.example.com/x'],
      ['an ip literal', 'https://169.254.169.254/latest'],
      ['a port', 'https://docs.example.com:8443/x'],
      ['the platform host', 'https://passbook.mobile/api'],
    ])('refuses a hop to %s', async (_n, to) => {
      const fetchImpl = site({ 'https://docs.example.com/pub': () => hop(to) });
      await expect(
        createSafeFetch({
          resolver: publicDns,
          fetchImpl,
          maxRedirects: 3,
          platformHosts: ['passbook.mobile'],
        })('https://docs.example.com/pub'),
      ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    });

    it('stops at the hop cap and never echoes the location', async () => {
      const fetchImpl = site({
        'https://a.example.com/': () => hop('https://b.example.com/secret-token'),
        'https://b.example.com/secret-token': () => hop('https://c.example.com/secret-token'),
        'https://c.example.com/secret-token': () => hop('https://d.example.com/secret-token'),
      });
      const err = await createSafeFetch({ resolver: publicDns, fetchImpl, maxRedirects: 2 })(
        'https://a.example.com/',
      ).catch((e: unknown) => e as Error);
      expect(err).toMatchObject({ code: 'REDIRECT_BLOCKED' });
      expect(String((err as Error).message)).not.toContain('secret-token');
    });

    it('refuses a redirect without a Location, and a redirect of a write', async () => {
      const bare = site({ 'https://a.example.com/': () => new Response(null, { status: 302 }) });
      await expect(
        createSafeFetch({ resolver: publicDns, fetchImpl: bare, maxRedirects: 3 })(
          'https://a.example.com/',
        ),
      ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
      const moved = site({ 'https://a.example.com/': () => hop('https://b.example.com/') });
      await expect(
        createSafeFetch({ resolver: publicDns, fetchImpl: moved, maxRedirects: 3 })(
          'https://a.example.com/',
          {
            method: 'POST',
            body: 'x',
          },
        ),
      ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    });

    it('drops credentials when the hop changes host, and keeps them on the same host', async () => {
      const seen: { url: string; headers: Headers }[] = [];
      const fetchImpl = site(
        {
          'https://a.example.com/1': () => hop('/2'),
          'https://a.example.com/2': () => hop('https://b.example.com/3'),
          'https://b.example.com/3': () => new Response('ok'),
        },
        seen,
      );
      await createSafeFetch({ resolver: publicDns, fetchImpl, maxRedirects: 3 })(
        'https://a.example.com/1',
        {
          headers: { authorization: 'Bearer t', 'x-api-key': 'k', accept: 'text/csv' },
        },
      );
      expect(seen[1]?.headers.get('authorization')).toBe('Bearer t');
      expect(seen[2]?.headers.get('authorization')).toBeNull();
      expect(seen[2]?.headers.get('x-api-key')).toBeNull();
      expect(seen[2]?.headers.get('accept')).toBe('text/csv');
    });

    it('holds every hop to the one deadline', async () => {
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url === 'https://a.example.com/') return hop('https://b.example.com/');
        return new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        );
      }) as unknown as typeof fetch;
      await expect(
        createSafeFetch({ resolver: publicDns, fetchImpl, maxRedirects: 3, timeoutMs: 50 })(
          'https://a.example.com/',
        ),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('is off by default, and capped at five hops however many are asked for', async () => {
      const chain: Record<string, () => Response> = {};
      for (let i = 0; i < 9; i++)
        chain[`https://h${i}.example.com/`] = () => hop(`https://h${i + 1}.example.com/`);
      const seen: { url: string; headers: Headers }[] = [];
      await expect(
        createSafeFetch({ resolver: publicDns, fetchImpl: site(chain, seen), maxRedirects: 50 })(
          'https://h0.example.com/',
        ),
      ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
      expect(seen).toHaveLength(6);
    });
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

  describe('deadline', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('aborts a body that trickles past the deadline', async () => {
      let cancelled = false;
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(new Uint8Array([120]));
            },
            cancel: () => {
              cancelled = true;
            },
          }),
        )) as unknown as typeof fetch;
      const safe = createSafeFetch({ resolver: publicDns, timeoutMs: 60 });
      await expect(safe('https://api.example.com')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await new Promise((r) => setTimeout(r, 20));
      expect(cancelled).toBe(true);
    });

    it('counts DNS against the deadline', async () => {
      const slowDns = { resolve: () => new Promise<string[]>(() => undefined) };
      const safe = createSafeFetch({ resolver: slowDns, fetchImpl: respond('x'), timeoutMs: 20 });
      await expect(safe('https://api.example.com')).rejects.toMatchObject({ code: 'TIMEOUT' });
    });
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
