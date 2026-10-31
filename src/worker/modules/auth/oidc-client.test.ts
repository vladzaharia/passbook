import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkAuthorizationIss,
  discover,
  issuerRelyingParty,
  type OidcFetch,
  OidcGrantRefusedError,
  OidcNetworkError,
  OidcVerifyError,
  oidcUrlProblem,
  redeemAuthorizationCode,
  resetOidcClientCaches,
  verifyIdToken,
} from './oidc-client.ts';

const ISSUER = 'https://idp.test';
const CLIENT = 'cid';
const rp = issuerRelyingParty({ issuer: ISSUER, clientId: CLIENT, clientSecret: 'secret' });
const NOW = Date.now();

interface Key {
  privateKey: CryptoKey;
  jwk: JWK;
}

async function makeKey(alg: string, kid: string): Promise<Key> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

async function sign(
  key: Key,
  claims: Record<string, unknown> = {},
  opts: { alg?: string; iss?: string; aud?: string | string[]; iat?: number; exp?: number } = {},
) {
  const iat = opts.iat ?? Math.floor(NOW / 1000);
  return new SignJWT({ nonce: 'n1', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: key.jwk.kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setSubject('sub-1')
    .setAudience(opts.aud ?? CLIENT)
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 300)
    .sign(key.privateKey);
}

interface Idp {
  fetch: OidcFetch;
  calls: string[];
  keys: JWK[];
  overrides: Record<string, () => Response>;
  doc: Record<string, unknown>;
}

function idp(keys: JWK[]): Idp {
  const state: Idp = {
    calls: [],
    keys,
    overrides: {},
    doc: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      authorization_response_iss_parameter_supported: true,
    },
    fetch: async (url, init) => {
      state.calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const override = state.overrides[new URL(url).pathname];
      if (override) return override();
      const path = new URL(url).pathname;
      if (path === '/.well-known/openid-configuration') return Response.json(state.doc);
      if (path === '/jwks') return Response.json({ keys: state.keys });
      return new Response('nope', { status: 404 });
    },
  };
  return state;
}

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
});

describe('oidcUrlProblem', () => {
  const hosts = ['idp.test'];
  it('accepts https on the allowlisted host', () => {
    expect(oidcUrlProblem('https://idp.test/x?y=1', hosts)).toBeNull();
  });
  it.each([
    ['http://idp.test/x', 'not https'],
    ['https://other.test/x', 'host not on the allowlist'],
    ['https://u:p@idp.test/', 'embeds credentials'],
    ['https://idp.test:8443/', 'names a port'],
    ['https://127.0.0.1/', 'IP literal'],
    ['https://localhost/', 'reserved host'],
    ['nonsense', 'not a URL'],
  ])('refuses %s', (url, reason) => {
    expect(oidcUrlProblem(url, hosts)).toBe(reason);
  });
  it('allows loopback http only when enabled', () => {
    expect(oidcUrlProblem('http://localhost:5174/a', ['localhost'])).toBe('not https');
    expect(oidcUrlProblem('http://localhost:5174/a', ['localhost'], true)).toBeNull();
    expect(oidcUrlProblem('http://evil.test/a', ['evil.test'], true)).toBe('not https');
  });
});

describe('discover', () => {
  it('pins the issuer and caches the document', async () => {
    const server = idp([]);
    const found = await discover(rp, { fetch: server.fetch });
    expect(found.tokenEndpoint).toBe(`${ISSUER}/token`);
    await discover(rp, { fetch: server.fetch });
    expect(server.calls).toHaveLength(1);
  });

  it('refuses an issuer mismatch', async () => {
    const server = idp([]);
    server.doc.issuer = 'https://evil.test';
    await expect(discover(rp, { fetch: server.fetch })).rejects.toThrow(OidcVerifyError);
  });

  it('refuses endpoints on another host', async () => {
    const server = idp([]);
    server.doc.token_endpoint = 'https://evil.test/token';
    await expect(discover(rp, { fetch: server.fetch })).rejects.toThrow(/token_endpoint refused/);
  });

  it('refuses a provider without the code flow', async () => {
    const server = idp([]);
    server.doc.response_types_supported = ['token'];
    await expect(discover(rp, { fetch: server.fetch })).rejects.toThrow(OidcVerifyError);
  });

  it('never follows redirects', async () => {
    const server = idp([]);
    server.overrides['/.well-known/openid-configuration'] = () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    await expect(discover(rp, { fetch: server.fetch })).rejects.toThrow(OidcNetworkError);
  });

  it('caps response size', async () => {
    const server = idp([]);
    server.overrides['/.well-known/openid-configuration'] = () =>
      new Response(JSON.stringify({ pad: 'x'.repeat(70_000) }), { status: 200 });
    await expect(discover(rp, { fetch: server.fetch })).rejects.toThrow(/too large/);
  });
});

describe('checkAuthorizationIss', () => {
  const found = { issuer: ISSUER, issParameterSupported: true };
  it('requires iss when promised and rejects a foreign one', () => {
    expect(() => checkAuthorizationIss(found, null)).toThrow(OidcVerifyError);
    expect(() => checkAuthorizationIss(found, 'https://evil.test')).toThrow(OidcVerifyError);
    expect(() => checkAuthorizationIss(found, ISSUER)).not.toThrow();
  });
  it('rejects a foreign iss even when not promised', () => {
    const quiet = { issuer: ISSUER, issParameterSupported: false };
    expect(() => checkAuthorizationIss(quiet, null)).not.toThrow();
    expect(() => checkAuthorizationIss(quiet, 'https://evil.test')).toThrow(OidcVerifyError);
  });
});

describe('verifyIdToken', () => {
  async function setup() {
    const key = await makeKey('RS256', 'k1');
    const server = idp([key.jwk]);
    const discovered = await discover(rp, { fetch: server.fetch });
    const verify = (token: string, nonce = 'n1', nowMs = NOW) =>
      verifyIdToken(discovered, rp, token, { nonce, fetch: server.fetch, nowMs });
    return { key, server, verify };
  }

  it('accepts a valid token', async () => {
    const { key, verify } = await setup();
    const claims = await verify(await sign(key));
    expect(claims.sub).toBe('sub-1');
  });

  it('rejects a wrong audience', async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, {}, { aud: 'other' }))).rejects.toThrow(OidcVerifyError);
  });

  it('requires azp for multiple audiences and rejects a foreign azp', async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, {}, { aud: [CLIENT, 'second'] }))).rejects.toThrow(/azp/);
    await expect(
      verify(await sign(key, { azp: CLIENT }, { aud: [CLIENT, 'second'] })),
    ).resolves.toBeTruthy();
    await expect(verify(await sign(key, { azp: 'other' }))).rejects.toThrow(/azp/);
  });

  it('rejects a wrong issuer', async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, {}, { iss: 'https://evil.test' }))).rejects.toThrow(
      OidcVerifyError,
    );
  });

  it('rejects expired tokens and tokens issued too long ago', async () => {
    const { key, verify } = await setup();
    const past = Math.floor(NOW / 1000) - 3600;
    await expect(verify(await sign(key, {}, { iat: past, exp: past + 300 }))).rejects.toThrow(
      OidcVerifyError,
    );
    const stale = Math.floor(NOW / 1000) - 600;
    await expect(
      verify(await sign(key, {}, { iat: stale, exp: Math.floor(NOW / 1000) + 3600 })),
    ).rejects.toThrow(OidcVerifyError);
  });

  it('rejects a wrong or missing nonce', async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, { nonce: 'other' }))).rejects.toThrow(OidcVerifyError);
    await expect(verify(await sign(key, { nonce: undefined }))).rejects.toThrow(OidcVerifyError);
  });

  it('rejects algorithms outside the allowlist', async () => {
    const key = await makeKey('PS256', 'ps');
    const server = idp([key.jwk]);
    const discovered = await discover(rp, { fetch: server.fetch });
    const token = await sign(key, {}, { alg: 'PS256' });
    await expect(
      verifyIdToken(discovered, rp, token, { nonce: 'n1', fetch: server.fetch, nowMs: NOW }),
    ).rejects.toThrow(OidcVerifyError);
  });

  it('rejects unsigned tokens', async () => {
    const { verify } = await setup();
    const enc = (o: object) => btoa(JSON.stringify(o)).replaceAll('=', '');
    const token = `${enc({ alg: 'none' })}.${enc({ iss: ISSUER, aud: CLIENT, sub: 'x', nonce: 'n1' })}.`;
    await expect(verify(token)).rejects.toThrow(OidcVerifyError);
  });

  it('rejects a signature from an unlisted key', async () => {
    const { verify } = await setup();
    const attacker = await makeKey('RS256', 'k1');
    await expect(verify(await sign(attacker))).rejects.toThrow(OidcVerifyError);
  });

  it('refetches the key set once for an unknown kid, then at most once a minute', async () => {
    const { key, server, verify } = await setup();
    await verify(await sign(key));
    const rotated = await makeKey('RS256', 'k2');
    server.keys = [key.jwk, rotated.jwk];
    const later = NOW + 120_000;
    await expect(verify(await sign(rotated), 'n1', later)).resolves.toBeTruthy();
    expect(server.calls.filter((c) => c.endsWith('/jwks'))).toHaveLength(2);

    const unknown = await makeKey('RS256', 'k3');
    await expect(verify(await sign(unknown), 'n1', later + 1000)).rejects.toThrow(OidcVerifyError);
    await expect(verify(await sign(unknown), 'n1', later + 2000)).rejects.toThrow(OidcVerifyError);
    expect(server.calls.filter((c) => c.endsWith('/jwks'))).toHaveLength(2);
  });
});

describe('redeemAuthorizationCode', () => {
  it('exchanges the code with the verifier and verifies the token', async () => {
    const key = await makeKey('RS256', 'k1');
    const server = idp([key.jwk]);
    let body = '';
    server.overrides['/token'] = () => new Response('unset');
    const base = server.fetch;
    const fetchImpl: OidcFetch = async (url, init) => {
      if (new URL(url).pathname === '/token') {
        body = String(init?.body);
        return Response.json({ id_token: await sign(key) });
      }
      return base(url, init);
    };
    const { claims } = await redeemAuthorizationCode(
      rp,
      { code: 'c1', iss: ISSUER, redirectUri: 'https://app/cb', codeVerifier: 'v1', nonce: 'n1' },
      { fetch: fetchImpl, nowMs: NOW },
    );
    expect(claims.sub).toBe('sub-1');
    const form = new URLSearchParams(body);
    expect(form.get('code_verifier')).toBe('v1');
    expect(form.get('client_id')).toBe(CLIENT);
    expect(form.get('grant_type')).toBe('authorization_code');
  });

  it('maps invalid_grant to a refusal and other failures to network errors', async () => {
    const server = idp([]);
    server.overrides['/token'] = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    const args = {
      code: 'c1',
      iss: ISSUER,
      redirectUri: 'https://app/cb',
      codeVerifier: 'v',
      nonce: 'n1',
    };
    await expect(redeemAuthorizationCode(rp, args, { fetch: server.fetch })).rejects.toThrow(
      OidcGrantRefusedError,
    );
    server.overrides['/token'] = () => new Response('boom', { status: 500 });
    await expect(redeemAuthorizationCode(rp, args, { fetch: server.fetch })).rejects.toThrow(
      OidcNetworkError,
    );
    server.overrides['/token'] = () => Response.json({ access_token: 'x' });
    await expect(redeemAuthorizationCode(rp, args, { fetch: server.fetch })).rejects.toThrow(
      /no id_token/,
    );
  });
});
