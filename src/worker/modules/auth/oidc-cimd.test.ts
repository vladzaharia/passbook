import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetOidcClientCaches } from './oidc-client.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type Jar, ORIGIN, type TestHarness } from './test-support.ts';

const METADATA_URL = `${ORIGIN}/auth/oidc/client-metadata.json`;
const member = { sub: 'sub-cimd', email: 'cimd@example.test', groups: ['wallet-users'] };

let h: TestHarness;
beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness({ OIDC_CLIENT_ID: METADATA_URL }, { publicClient: true });
});
afterEach(() => h.restore());

describe('client ID metadata document', () => {
  it('describes Wallet as a public client with exact redirect URIs', async () => {
    const res = await h.call('/auth/oidc/client-metadata.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const text = await res.text();
    expect(text.length).toBeLessThan(5 * 1024);
    expect(JSON.parse(text)).toMatchObject({
      client_id: METADATA_URL,
      redirect_uris: [`${ORIGIN}/auth/oidc/callback`],
      post_logout_redirect_uris: [`${ORIGIN}/login`],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid email profile groups',
    });
  });

  it('signs in with the metadata URL as client id and never sends a secret', async () => {
    const jar: Jar = new Map();
    const { start, res } = await oidcSignIn(h, jar, member);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(authorize.searchParams.get('client_id')).toBe(METADATA_URL);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    // The mock refuses any client_secret for a public client, so a 302 home proves none was sent.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('is not served for a registered client id', async () => {
    h.restore();
    h = await harness();
    expect((await h.call('/auth/oidc/client-metadata.json')).status).toBe(404);
  });

  it('is not served when the deployment is not https', async () => {
    h.restore();
    h = await harness(
      {
        PUBLIC_BASE_URL: 'http://localhost:5173',
        OIDC_CLIENT_ID: 'http://localhost:5173/auth/oidc/client-metadata.json',
        OIDC_CLIENT_SECRET: '',
      },
      { publicClient: true },
    );
    expect((await h.call('/auth/oidc/client-metadata.json')).status).toBe(404);
    expect((await h.call('/auth/oidc/start')).status).toBe(503);
  });
});
