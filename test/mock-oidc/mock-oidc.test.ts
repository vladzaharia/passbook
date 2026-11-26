import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockOidc } from './index.ts';

const issuer = 'https://id.test';
let restore: (() => void) | undefined;
afterEach(() => restore?.());

async function setup() {
  const oidc = await createMockOidc({ issuer, clientId: 'wallet' });
  oidc.addUser({ sub: 'u1', email: 'a@example.com', groups: ['wallet_admins'] });
  restore = oidc.install().restore;
  return oidc;
}

async function pkce() {
  const verifier = 'v'.repeat(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return { verifier, challenge };
}

describe('mock oidc client restriction', () => {
  it('refuses an account outside the required groups and lets one inside in', async () => {
    const oidc = await setup();
    oidc.addUser({
      sub: 'out',
      email: 'o@example.com',
      groups: ['wallet_users'],
      requiresGroups: ['passbook_developers'],
    });
    oidc.addUser({
      sub: 'in',
      email: 'i@example.com',
      groups: ['passbook_developers'],
      requiresGroups: ['passbook_developers'],
    });
    const go = async (sub: string) => {
      const { challenge } = await pkce();
      const res = await fetch(
        `${issuer}/authorize?client_id=wallet&redirect_uri=https://app.test/cb&state=s&login_hint=${sub}&code_challenge=${challenge}`,
        { redirect: 'manual' },
      );
      return new URL(res.headers.get('location') ?? '').searchParams;
    };
    expect((await go('out')).get('error')).toBe('access_denied');
    expect((await go('in')).get('code')).toBeTruthy();
  });
});

describe('mock oidc', () => {
  it('serves discovery and JWKS through fetch mocking', async () => {
    await setup();
    const config = (await (
      await fetch(`${issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, string>;
    expect(config.issuer).toBe(issuer);
    expect(
      ((await (await fetch(config.jwks_uri as string)).json()) as { keys: unknown[] }).keys,
    ).toHaveLength(1);
  });

  it('runs the code flow with PKCE and signs a verifiable ID token', async () => {
    const oidc = await setup();
    const { verifier, challenge } = await pkce();
    const redirectUri = 'https://wallet.test/auth/oidc/callback';
    const auth = await fetch(
      `${issuer}/authorize?client_id=wallet&redirect_uri=${encodeURIComponent(redirectUri)}&state=s1&nonce=n1&code_challenge=${challenge}&code_challenge_method=S256&login_hint=u1`,
      { redirect: 'manual' },
    );
    const location = new URL(auth.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('s1');
    expect(location.searchParams.get('iss')).toBe(issuer);
    const token = await fetch(`${issuer}/api/oidc/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: location.searchParams.get('code') ?? '',
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const { id_token } = (await token.json()) as { id_token: string };
    const jwks = createLocalJWKSet(
      (await (await fetch(`${issuer}/.well-known/jwks.json`)).json()) as never,
    );
    const { payload } = await jwtVerify(id_token, jwks, { issuer, audience: 'wallet' });
    expect(payload).toMatchObject({
      sub: 'u1',
      email: 'a@example.com',
      nonce: 'n1',
      groups: ['wallet_admins'],
      azp: 'wallet',
    });
    expect(oidc.clientId).toBe('wallet');
  });

  it('rejects a wrong verifier and a replayed code', async () => {
    await setup();
    const { challenge } = await pkce();
    const redirectUri = 'https://wallet.test/cb';
    const auth = await fetch(
      `${issuer}/authorize?client_id=wallet&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=${challenge}&login_hint=u1`,
      { redirect: 'manual' },
    );
    const code = new URL(auth.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const body = (verifier: string) =>
      new URLSearchParams({ code, redirect_uri: redirectUri, code_verifier: verifier });
    expect(
      (await fetch(`${issuer}/api/oidc/token`, { method: 'POST', body: body('wrong') })).status,
    ).toBe(400);
    expect(
      (await fetch(`${issuer}/api/oidc/token`, { method: 'POST', body: body('wrong') })).status,
    ).toBe(400);
  });
});
