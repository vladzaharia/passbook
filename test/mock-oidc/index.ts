import type { JWK } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface MockOidcUser {
  sub: string;
  email: string;
  name?: string;
  groups?: string[];
  emailVerified?: boolean;
}

export interface MockOidcOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Used when /authorize has no `login_hint` matching a known user. */
  defaultUser?: MockOidcUser;
  now?: () => number;
}

interface PendingCode {
  user: MockOidcUser;
  nonce: string | null;
  challenge: string | null;
  redirectUri: string;
  authTime: number;
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Minimal Pocket ID stand-in: discovery, JWKS, authorize (auto-approves), token (PKCE S256).
 * Same handler backs worker tests (fetch mocking via `install`) and the Playwright node server.
 */
export async function createMockOidc(options: MockOidcOptions) {
  const issuer = options.issuer.replace(/\/$/, '');
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'mock-1', alg: 'RS256', use: 'sig' };
  const users = new Map<string, MockOidcUser>();
  const codes = new Map<string, PendingCode>();
  const now = options.now ?? Date.now;
  let counter = 0;

  async function idToken(
    user: MockOidcUser,
    extra: { nonce: string | null; authTime: number },
  ): Promise<string> {
    const claims: Record<string, unknown> = {
      email: user.email,
      email_verified: user.emailVerified ?? true,
      name: user.name ?? user.email,
      groups: user.groups ?? [],
      azp: options.clientId,
      auth_time: Math.floor(extra.authTime / 1000),
      ...(extra.nonce ? { nonce: extra.nonce } : {}),
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
      .setIssuer(issuer)
      .setSubject(user.sub)
      .setAudience(options.clientId)
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(Math.floor(now() / 1000) + 300)
      .sign(privateKey);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/.well-known/openid-configuration') {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/api/oidc/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
        end_session_endpoint: `${issuer}/api/oidc/end-session`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
      });
    }
    if (path === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (path === '/authorize') {
      const p = url.searchParams;
      const user = users.get(p.get('login_hint') ?? '') ?? options.defaultUser;
      const redirect = p.get('redirect_uri');
      if (!user || !redirect || p.get('client_id') !== options.clientId)
        return new Response('bad request', { status: 400 });
      const code = `code-${++counter}`;
      codes.set(code, {
        user,
        nonce: p.get('nonce'),
        challenge: p.get('code_challenge'),
        redirectUri: redirect,
        authTime: now(),
      });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', p.get('state') ?? '');
      target.searchParams.set('iss', issuer);
      return Response.redirect(target.toString(), 302);
    }
    if (path === '/api/oidc/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!pending || form.get('redirect_uri') !== pending.redirectUri)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (pending.challenge) {
        const digest = b64url(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(form.get('code_verifier') ?? ''),
          ),
        );
        if (digest !== pending.challenge)
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        token_type: 'Bearer',
        access_token: `access-${counter}`,
        expires_in: 300,
        id_token: await idToken(pending.user, { nonce: pending.nonce, authTime: pending.authTime }),
      });
    }
    if (path === '/api/oidc/end-session')
      return Response.redirect(url.searchParams.get('post_logout_redirect_uri') ?? issuer, 302);
    return new Response('not found', { status: 404 });
  }

  return {
    issuer,
    clientId: options.clientId,
    /** Registers a user selectable with `login_hint=<sub>`. */
    addUser(user: MockOidcUser): MockOidcUser {
      users.set(user.sub, user);
      return user;
    },
    /** Signs an arbitrary ID token (for negative tests: wrong aud, expired, bad nonce). */
    signIdToken: (user: MockOidcUser, nonce: string | null = null) =>
      idToken(user, { nonce, authTime: now() }),
    handle,
    /** Routes fetches to the issuer origin to the mock; everything else goes to `fallback`. */
    install(fallback: typeof fetch = fetch): { restore(): void } {
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.startsWith(issuer)) {
          return handle(new Request(request.url.replace(issuer, 'http://mock'), request));
        }
        return fallback(input, init);
      }) as typeof fetch;
      return {
        restore: () => {
          globalThis.fetch = original;
        },
      };
    },
  };
}

export type MockOidc = Awaited<ReturnType<typeof createMockOidc>>;
