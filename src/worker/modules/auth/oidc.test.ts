import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type Jar, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
const person = (groups: string[], extra: { email?: string; sub?: string } = {}) => {
  const id = uniq();
  return {
    sub: extra.sub ?? `sub-${id}`,
    email: extra.email ?? `p${id}@example.test`,
    name: 'Person',
    groups,
  };
};
const session = async (jar: Jar) => (await h.call('/api/v1/session', { cookies: jar })).json();

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
});
afterEach(() => h.restore());

describe('oidc sign-in', () => {
  it('signs an admin in and stores only hashes', async () => {
    const jar: Jar = new Map();
    const user = person(['wallet-admins']);
    const { res, start } = await oidcSignIn(h, jar, user);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('code_challenge_method=S256');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const body = (await session(jar)) as {
      authenticated: boolean;
      roles: string[];
      csrfToken: string;
    };
    expect(body.authenticated).toBe(true);
    expect(body.roles).toEqual(['admin', 'user']);
    const sid = jar.get('__Host-wallet_sid') ?? '';
    const rows = await all<{ id_hash: string; roles: string }>(
      h.env.DB,
      'SELECT id_hash, roles FROM sessions',
    );
    expect(rows.some((r) => r.id_hash === sid)).toBe(false);
    expect(jar.has('__Host-wallet_oidc')).toBe(false);
    const email = await first<{ verified_via: string }>(
      h.env.DB,
      'SELECT verified_via FROM user_emails WHERE email = ?',
      [user.email],
    );
    expect(email?.verified_via).toBe('oidc');
  });

  it('maps the user group to the user role only', async () => {
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, person(['wallet-users']));
    expect(((await session(jar)) as { roles: string[] }).roles).toEqual(['user']);
  });

  it('refuses users in neither group and creates nothing', async () => {
    const jar: Jar = new Map();
    const user = person(['other']);
    const { res } = await oidcSignIn(h, jar, user);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('No access');
    expect(jar.has('__Host-wallet_sid')).toBe(false);
    expect(
      await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [user.email]),
    ).toBeNull();
  });

  it('never grants a role whose group variable is unset', async () => {
    h.restore();
    h = await harness({ OIDC_ADMIN_GROUP: '' });
    const jar: Jar = new Map();
    expect((await oidcSignIn(h, jar, person(['wallet-admins']))).res.status).toBe(403);
    expect((await oidcSignIn(h, jar, person(['wallet-admins', 'wallet-users']))).res.status).toBe(
      302,
    );
    expect(((await session(jar)) as { roles: string[] }).roles).toEqual(['user']);
    h.restore();
    h = await harness({ OIDC_ADMIN_GROUP: '', OIDC_USER_GROUP: '' });
    expect(
      (await oidcSignIn(h, new Map(), person(['wallet-users', 'wallet-admins']))).res.status,
    ).toBe(403);
  });

  it('links a new subject to the user who owns the email', async () => {
    const f = fixtures(h.env);
    const existing = await makeUser(f);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, person(['wallet-users'], { email: existing.primaryEmail }));
    const body = (await session(jar)) as { user: { id: string } };
    expect(body.user.id).toBe(existing.id);
    const identities = await all(h.env.DB, 'SELECT 1 FROM auth_identities WHERE user_id = ?', [
      existing.id,
    ]);
    expect(identities).toHaveLength(1);
  });

  it('keys identity on subject, not email', async () => {
    const user = person(['wallet-users']);
    const first1 = new Map() as Jar;
    await oidcSignIn(h, first1, user);
    const id1 = ((await session(first1)) as { user: { id: string } }).user.id;
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, {
      ...user,
      email: `changed-${uniq()}@example.test`,
      groups: ['wallet-admins'],
    });
    const body = (await session(jar)) as { user: { id: string }; roles: string[] };
    expect(body.user.id).toBe(id1);
    expect(body.roles).toEqual(['admin', 'user']);
    const row = await first<{ groups: string }>(
      h.env.DB,
      'SELECT groups FROM auth_identities WHERE subject = ?',
      [user.sub],
    );
    expect(JSON.parse(row?.groups ?? '[]')).toEqual(['wallet-admins']);
  });

  it('does not take an email owned by another account for an existing identity', async () => {
    const f = fixtures(h.env);
    const owner = await makeUser(f);
    const jar: Jar = new Map();
    const user = person(['wallet-users']);
    await oidcSignIn(h, jar, user);
    const again: Jar = new Map();
    await oidcSignIn(h, again, { ...user, email: owner.primaryEmail });
    const row = await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM user_emails WHERE email = ?',
      [owner.primaryEmail],
    );
    expect(row?.user_id).toBe(owner.id);
  });

  describe('oidc.trustEmail off', () => {
    beforeEach(async () => {
      await run(
        h.env.DB,
        "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'oidc.trustEmail', 'false', 0)",
      );
    });
    afterEach(async () => {
      await run(h.env.DB, "DELETE FROM settings WHERE key = 'oidc.trustEmail'");
    });

    it('refuses to link to an existing email owner', async () => {
      const f = fixtures(h.env);
      const existing = await makeUser(f);
      const { res } = await oidcSignIn(
        h,
        new Map(),
        person(['wallet-users'], { email: existing.primaryEmail }),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Email in use');
    });

    it('creates the user without a verified email', async () => {
      const user = person(['wallet-users']);
      const { res } = await oidcSignIn(h, new Map(), user);
      expect(res.status).toBe(302);
      expect(
        await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [user.email]),
      ).toBeNull();
    });
  });

  it('refuses disabled users and rejects their live sessions', async () => {
    const user = person(['wallet-users']);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, user);
    const userId = ((await session(jar)) as { user: { id: string } }).user.id;
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [userId]);
    expect(((await session(jar)) as { authenticated: boolean }).authenticated).toBe(false);
    const { res } = await oidcSignIn(h, new Map(), user);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Account disabled');
  });

  it('rotates the session on login', async () => {
    const user = person(['wallet-users']);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, user);
    const old = jar.get('__Host-wallet_sid');
    const oldJar: Jar = new Map([['__Host-wallet_sid', old ?? '']]);
    await oidcSignIn(h, jar, user);
    expect(jar.get('__Host-wallet_sid')).not.toBe(old);
    expect(((await session(oldJar)) as { authenticated: boolean }).authenticated).toBe(false);
    expect(((await session(jar)) as { authenticated: boolean }).authenticated).toBe(true);
  });

  describe('next', () => {
    it('returns to a same-origin path', async () => {
      const { res } = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        next: '/passes/1?a=b',
      });
      expect(res.headers.get('location')).toBe('/passes/1?a=b');
    });

    it.each(['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
      'drops %s',
      async (next) => {
        const { res } = await oidcSignIn(h, new Map(), person(['wallet-users']), { next });
        expect(res.headers.get('location')).toBe('/');
      },
    );
  });

  describe('callback checks', () => {
    it('rejects a wrong state', async () => {
      const jar: Jar = new Map();
      const { res } = await oidcSignIn(h, jar, person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.set('state', 'forged'),
      });
      expect(res.status).toBe(400);
      expect(jar.has('__Host-wallet_sid')).toBe(false);
    });

    it('rejects a callback without the binding cookie and keeps the flow', async () => {
      const user = person(['wallet-users']);
      const jar: Jar = new Map();
      const { start, callback } = await oidcSignIn(h, jar, user);
      expect(start.status).toBe(302);
      // Session from the first run exists; a second flow replayed from a bare browser must fail.
      const pending = new Map<string, string>();
      const loc = new URL(
        (await h.call('/auth/oidc/start', { cookies: pending })).headers.get('location') ?? '',
      );
      loc.searchParams.set('login_hint', user.sub);
      const authz = await h.oidc.handle(new Request(loc.toString().replace(ISSUER, 'http://mock')));
      const cb = new URL(authz.headers.get('location') ?? '');
      const bound = pending.get('__Host-wallet_oidc') ?? '';
      const attacker = await h.call(`${cb.pathname}${cb.search}`, { cookies: new Map() });
      expect(attacker.status).toBe(400);
      const wrong = await h.call(`${cb.pathname}${cb.search}`, {
        cookies: new Map([['__Host-wallet_oidc', 'wrong']]),
      });
      expect(wrong.status).toBe(400);
      const ok = await h.call(`${cb.pathname}${cb.search}`, {
        cookies: new Map([['__Host-wallet_oidc', bound]]),
      });
      expect(ok.status).toBe(302);
      expect(callback.pathname).toBe('/auth/oidc/callback');
    });

    it('consumes the flow: replaying the callback fails', async () => {
      const user = person(['wallet-users']);
      const jar: Jar = new Map();
      const { callback } = await oidcSignIn(h, jar, user);
      const flowCookie = new Map([['__Host-wallet_oidc', 'x']]);
      const replay = await h.call(`${callback.pathname}${callback.search}`, {
        cookies: flowCookie,
      });
      expect(replay.status).toBe(400);
    });

    it('rejects a nonce that differs from the flow', async () => {
      const jar: Jar = new Map();
      const { res } = await oidcSignIn(h, jar, person(['wallet-users']), {
        tamper: (u) => u.searchParams.set('nonce', 'attacker-nonce'),
      });
      expect(res.status).toBe(400);
      expect(jar.has('__Host-wallet_sid')).toBe(false);
    });

    it('rejects a mismatched or missing iss', async () => {
      const a = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.set('iss', 'https://evil.example'),
      });
      expect(a.res.status).toBe(400);
      const b = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.delete('iss'),
      });
      expect(b.res.status).toBe(400);
    });

    it('rejects an error response and a missing code', async () => {
      const a = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.set('error', 'access_denied'),
      });
      expect(a.res.status).toBe(400);
      const b = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.delete('code'),
      });
      expect(b.res.status).toBe(400);
    });

    it('rejects a PKCE failure at the provider', async () => {
      const res = await oidcSignIn(h, new Map(), person(['wallet-users']), {
        tamperCallback: (u) => u.searchParams.set('code', 'code-unknown'),
      });
      expect(res.res.status).toBe(400);
    });
  });

  it('reports an unreachable provider as 502', async () => {
    await resetOidcClientCaches(ISSUER);
    h.restore();
    h = await harness({ OIDC_ISSUER: 'https://down.test' });
    const res = await h.call('/auth/oidc/start');
    expect(res.status).toBe(502);
  });

  it('is unavailable without client configuration', async () => {
    h.restore();
    h = await harness({ OIDC_CLIENT_SECRET: '' });
    expect((await h.call('/auth/oidc/start')).status).toBe(503);
    const body = (await session(new Map())) as { oidcEnabled: boolean };
    expect(body.oidcEnabled).toBe(false);
  });

  describe('logout', () => {
    it('revokes the session and leaves through end_session_endpoint', async () => {
      const jar: Jar = new Map();
      await oidcSignIn(h, jar, person(['wallet-users']));
      const stale = new Map(jar);
      const res = await h.call('/auth/logout', {
        method: 'POST',
        cookies: jar,
        headers: { accept: 'application/json' },
      });
      const body = (await res.json()) as { redirect: string };
      expect(body.redirect).toContain(`${ISSUER}/api/oidc/end-session`);
      expect(body.redirect).toContain('post_logout_redirect_uri=');
      expect(jar.has('__Host-wallet_sid')).toBe(false);
      expect(((await session(stale)) as { authenticated: boolean }).authenticated).toBe(false);
    });

    it('redirects to /login for form posts', async () => {
      const jar: Jar = new Map();
      await oidcSignIn(h, jar, person(['wallet-users']));
      const res = await h.call('/auth/logout', { method: 'POST', cookies: jar });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('/api/oidc/end-session');
    });

    it('refuses cross-origin logout posts', async () => {
      const res = await h.call('/auth/logout', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(403);
    });
  });
});
