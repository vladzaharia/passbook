import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import type { AppEnv } from './env.ts';
import { hostDecision, redirectHosts } from './host-policy.ts';
import { ROBOTS } from './security-headers.ts';

const CANONICAL = 'https://passbook.mobile';
const LEGACY = 'https://wallet.plrs.im';
const hosts = { PUBLIC_BASE_URL: CANONICAL, REDIRECT_HOSTS: 'wallet.plrs.im' };
const decide = (url: string) => hostDecision(hosts, new URL(url));

describe('hostDecision', () => {
  it('serves the canonical origin', () => {
    expect(decide(`${CANONICAL}/`)).toEqual({ action: 'serve' });
    expect(decide(`${CANONICAL}/wallet/v1/log`)).toEqual({ action: 'serve' });
  });

  it('upgrades the canonical host over plain http', () => {
    expect(decide('http://passbook.mobile/login?next=%2F')).toEqual({
      action: 'redirect',
      location: `${CANONICAL}/login?next=%2F`,
    });
  });

  it.each([
    '/',
    '/login?next=%2Fadmin',
    '/p/abcdefghijklmnopqrstuv',
    '/p/abcdefghijklmnopqrstuv/pass.pkpass',
    '/p/abcdefghijklmnopqrstuv/assets/icon.png',
    '/wallet/v1/devices/d/registrations/pass.im.plrs.wallet/s',
    '/wallet/v1/passes/pass.im.plrs.wallet/s',
    '/auth/oidc/client-metadata.json',
    '/auth/magic?token=abc',
    '/api/v1/passes?limit=5',
    '/email/buddy-happy-dark-top-2x.png',
  ])('moves %s on the legacy host to the same path and query', (path) => {
    expect(decide(`${LEGACY}${path}`)).toEqual({
      action: 'redirect',
      location: `${CANONICAL}${path}`,
    });
  });

  it('refuses any other host, including the canonical name on another port', () => {
    for (const url of [
      'https://evil.example/',
      'https://wallet.plrs.im.evil.example/',
      'https://sub.passbook.mobile/',
      'https://passbook.mobile:8443/',
      'https://plrs.im/',
    ])
      expect(decide(url), url).toEqual({ action: 'refuse' });
  });

  it('reads REDIRECT_HOSTS as a trimmed, case-insensitive list', () => {
    expect(
      redirectHosts({ PUBLIC_BASE_URL: CANONICAL, REDIRECT_HOSTS: ' A.example , b.example,' }),
    ).toEqual(['a.example', 'b.example']);
    expect(redirectHosts({ PUBLIC_BASE_URL: CANONICAL })).toEqual([]);
    expect(decide('https://WALLET.plrs.im/x').action).toBe('redirect');
  });
});

const SHELL = '<!doctype html><title>PassBook</title>';
const assetHeaders = {
  'content-type': 'text/html',
  'content-security-policy':
    "default-src 'none'; script-src 'self' https://challenges.cloudflare.com",
};

function appEnv(fetched: string[] = []): AppEnv {
  const ASSETS = {
    fetch: async (input: Request) => {
      fetched.push(new URL(input.url).pathname);
      return new Response(SHELL, { headers: assetHeaders });
    },
  };
  return {
    ...env,
    ...hosts,
    OIDC_CLIENT_ID: `${CANONICAL}/auth/oidc/client-metadata.json`,
    ASSETS,
  } as unknown as AppEnv;
}

const app = createApp({ stores: fakeAuth(CANONICAL).stores, hostPolicy: true });
const call = (url: string, init: RequestInit = {}, e = appEnv()) => app.request(url, init, e);

describe('host policy in the app', () => {
  it('serves the API, Apple and the metadata document on the canonical host', async () => {
    expect((await call(`${CANONICAL}/health`)).status).toBe(200);
    const doc = await call(`${CANONICAL}/auth/oidc/client-metadata.json`);
    expect(doc.status).toBe(200);
    expect(await doc.json()).toMatchObject({
      client_id: `${CANONICAL}/auth/oidc/client-metadata.json`,
      redirect_uris: [`${CANONICAL}/auth/oidc/callback`],
      logo_uri: `${CANONICAL}/icons/icon-512.png`,
    });
  });

  it('answers every legacy request, any method, with an uncached 308', async () => {
    const fetched: string[] = [];
    for (const [method, path] of [
      ['GET', '/p/abcdefghijklmnopqrstuv?utm=mail'],
      ['GET', '/p/abcdefghijklmnopqrstuv/pass.pkpass'],
      ['POST', '/wallet/v1/devices/d/registrations/pass.im.plrs.wallet/s'],
      ['DELETE', '/wallet/v1/devices/d/registrations/pass.im.plrs.wallet/s'],
      ['GET', '/auth/oidc/client-metadata.json'],
      ['GET', '/login?next=%2Fpasses'],
      ['HEAD', '/'],
      ['PATCH', '/api/v1/passes/x'],
    ] as const) {
      const res = await call(`${LEGACY}${path}`, { method }, appEnv(fetched));
      expect(res.status, `${method} ${path}`).toBe(308);
      expect(res.headers.get('location')).toBe(`${CANONICAL}${path}`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(fetched).toEqual([]);
  });

  it('refuses an unknown host with 421 problem+json', async () => {
    const res = await call('https://elsewhere.example/health');
    expect(res.status).toBe(421);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'HOST_UNKNOWN' });
  });

  it("serves the SPA's pages from static assets with their own headers", async () => {
    const fetched: string[] = [];
    for (const path of ['/', '/login', '/admin/orgs', '/passes/0191']) {
      const res = await call(`${CANONICAL}${path}`, {}, appEnv(fetched));
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(SHELL);
      // Indexable sign-in page; the CSP that allows Turnstile comes from public/_headers.
      expect(res.headers.get('x-robots-tag')).not.toBe(ROBOTS);
      expect(res.headers.get('content-security-policy')).toBe(
        assetHeaders['content-security-policy'],
      );
    }
    expect(fetched).toEqual(['/', '/login', '/admin/orgs', '/passes/0191']);
  });

  it('keeps Worker paths and unknown files out of the SPA', async () => {
    const fetched: string[] = [];
    for (const path of ['/api/v1/nope', '/auth/nothing', '/p/x/y', '/hooks/x', '/sitemap.xml']) {
      const res = await call(`${CANONICAL}${path}`, {}, appEnv(fetched));
      expect(res.status, path).toBe(404);
    }
    expect((await call(`${CANONICAL}/login`, { method: 'POST' })).status).toBe(404);
    expect(fetched).toEqual([]);
  });
});
