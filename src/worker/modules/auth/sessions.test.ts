import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSession, createSessionStore, revokeAllForUser, revokeOne } from './sessions.ts';
import { harness, type Jar, type TestHarness } from './test-support.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let h: TestHarness;
let clock: ManualClock;

beforeEach(async () => {
  clock = new ManualClock(Date.now());
  h = await harness({}, { clock });
});
afterEach(() => h.restore());

async function open(roles: ('admin' | 'user')[], disabled = false) {
  const user = await makeUser(fixtures(h.env));
  if (disabled) await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
  const ctx = createServiceContext(h.env, { clock });
  const session = await createSession(ctx, {
    userId: user.id,
    roles,
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const store = createSessionStore(h.env, clock);
  return { user, session, store, ctx };
}

describe('session store', () => {
  it('resolves a fresh session and stores only the hash', async () => {
    const { user, session, store } = await open(['user']);
    const auth = await store.resolve(session.cookieValue);
    expect(auth).toMatchObject({ kind: 'session', userId: user.id, roles: ['user'], amr: 'oidc' });
    expect(auth?.csrfSecret).toBe(session.csrfSecret);
    const row = await first(h.env.DB, 'SELECT 1 FROM sessions WHERE id_hash = ?', [
      session.cookieValue,
    ]);
    expect(row).toBeNull();
    expect(session.idHash).toBe(await sha256Hex(session.cookieValue));
  });

  it('rejects unknown, empty and oversized cookie values', async () => {
    const { store } = await open(['user']);
    expect(await store.resolve('nope')).toBeNull();
    expect(await store.resolve('')).toBeNull();
    expect(await store.resolve('x'.repeat(1000))).toBeNull();
  });

  it('resolves sessions made by the shared test factory', async () => {
    const f = fixtures(h.env);
    const user = await makeUser(f);
    const fixture = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    const auth = await createSessionStore(h.env, f.clock).resolve(fixture.cookieValue);
    expect(auth?.roles).toEqual(['admin', 'user']);
  });

  describe('timeouts', () => {
    it('user sessions: 30 day idle window slides, 90 day absolute limit holds', async () => {
      const { session, store } = await open(['user']);
      clock.advance(29 * DAY);
      expect(await store.resolve(session.cookieValue)).not.toBeNull();
      clock.advance(29 * DAY);
      expect(await store.resolve(session.cookieValue)).not.toBeNull();
      clock.advance(29 * DAY);
      expect(await store.resolve(session.cookieValue)).not.toBeNull();
      clock.advance(4 * DAY);
      expect(await store.resolve(session.cookieValue)).toBeNull();
    });

    it('user sessions expire after 30 idle days', async () => {
      const { session, store } = await open(['user']);
      clock.advance(30 * DAY + 1);
      expect(await store.resolve(session.cookieValue)).toBeNull();
    });

    it('admin sessions: 1 hour idle', async () => {
      const { session, store } = await open(['admin', 'user']);
      clock.advance(59 * MIN);
      expect(await store.resolve(session.cookieValue)).not.toBeNull();
      clock.advance(61 * MIN);
      expect(await store.resolve(session.cookieValue)).toBeNull();
    });

    it('admin sessions: 12 hour absolute limit despite activity', async () => {
      const { session, store } = await open(['admin', 'user']);
      for (let i = 0; i < 23; i++) {
        clock.advance(30 * MIN);
        expect(await store.resolve(session.cookieValue)).not.toBeNull();
      }
      clock.advance(31 * MIN);
      expect(await store.resolve(session.cookieValue)).toBeNull();
    });
  });

  it('throttles last_seen writes', async () => {
    const { session, store } = await open(['user']);
    const seen = async () =>
      (
        await first<{ last_seen_at: number }>(
          h.env.DB,
          'SELECT last_seen_at FROM sessions WHERE id_hash = ?',
          [session.idHash],
        )
      )?.last_seen_at;
    const created = await seen();
    clock.advance(2 * MIN);
    await store.resolve(session.cookieValue);
    expect(await seen()).toBe(created);
    clock.advance(4 * MIN);
    await store.resolve(session.cookieValue);
    expect(await seen()).toBe(clock.now());
  });

  it('refuses revoked sessions', async () => {
    const { session, store, ctx } = await open(['user']);
    expect(await revokeOne(ctx, session.idHash)).toBe(true);
    expect(await revokeOne(ctx, session.idHash)).toBe(false);
    expect(await store.resolve(session.cookieValue)).toBeNull();
  });

  it('revokes all of a user sessions, optionally keeping one', async () => {
    const { user, session, store, ctx } = await open(['user']);
    const second = await createSession(ctx, {
      userId: user.id,
      roles: ['user'],
      amr: 'magic_link',
      ipPrefix: null,
      userAgent: null,
    });
    expect(await revokeAllForUser(ctx, user.id, session.idHash)).toBe(1);
    expect(await store.resolve(session.cookieValue)).not.toBeNull();
    expect(await store.resolve(second.cookieValue)).toBeNull();
    expect(await revokeAllForUser(ctx, user.id)).toBe(1);
    expect(await store.resolve(session.cookieValue)).toBeNull();
  });

  it('refuses sessions of disabled users', async () => {
    const { session, store, user } = await open(['user']);
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(await store.resolve(session.cookieValue)).toBeNull();
    await run(h.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    expect(await store.resolve(session.cookieValue)).not.toBeNull();
  });
});

describe('http', () => {
  async function signIn(roles: ('admin' | 'user')[]) {
    const { session } = await open(roles);
    const jar: Jar = new Map([['__Host-wallet_sid', session.cookieValue]]);
    return { jar, csrf: session.csrfSecret };
  }

  it('reports signed-out state with sign-in options', async () => {
    const res = await h.call('/api/v1/session');
    expect(await res.json()).toMatchObject({
      authenticated: false,
      oidcEnabled: true,
      magicLinkEnabled: true,
      turnstileSiteKey: expect.any(String),
    });
  });

  it('returns user, roles, csrf token and expiry', async () => {
    const { jar, csrf } = await signIn(['admin', 'user']);
    const body = (await (await h.call('/api/v1/session', { cookies: jar })).json()) as {
      authenticated: boolean;
      roles: string[];
      csrfToken: string;
      expiresAt: number;
    };
    expect(body.authenticated).toBe(true);
    expect(body.roles).toEqual(['admin', 'user']);
    expect(body.csrfToken).toBe(csrf);
    expect(body.expiresAt).toBeGreaterThan(clock.now());
  });

  it('enforces CSRF on cookie writes', async () => {
    const { jar, csrf } = await signIn(['user']);
    const post = (headers: Record<string, string>) =>
      h.call('/api/v1/me/sessions/revoke-all', {
        method: 'POST',
        cookies: new Map(jar),
        headers,
      });
    const noToken = await post({});
    expect(noToken.status).toBe(403);
    expect(((await noToken.json()) as { code: string }).code).toBe('CSRF_TOKEN');
    expect((await post({ 'x-csrf-token': 'wrong' })).status).toBe(403);
    const crossSite = await post({ 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' });
    expect(((await crossSite.json()) as { code: string }).code).toBe('CSRF_ORIGIN');
    expect((await post({ 'x-csrf-token': csrf })).status).toBe(200);
  });

  it('needs no CSRF token for reads', async () => {
    const { jar } = await signIn(['user']);
    expect((await h.call('/api/v1/me/emails', { cookies: jar })).status).toBe(200);
  });

  it('answers 401 without a session and 403 for non-admins on admin routes', async () => {
    expect((await h.call('/api/v1/users')).status).toBe(401);
    const { jar } = await signIn(['user']);
    expect((await h.call('/api/v1/users', { cookies: jar })).status).toBe(403);
  });

  it('logs out: revokes server-side and clears the cookie', async () => {
    const { jar, csrf } = await signIn(['user']);
    const copy = new Map(jar);
    const res = await h.call('/auth/logout', { method: 'POST', cookies: jar });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/api/oidc/end-session');
    expect(jar.has('__Host-wallet_sid')).toBe(false);
    expect(csrf).toBeTruthy();
    const body = (await (await h.call('/api/v1/session', { cookies: copy })).json()) as {
      authenticated: boolean;
    };
    expect(body.authenticated).toBe(false);
  });

  it('logout without a session is harmless', async () => {
    const res = await h.call('/auth/logout', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(await res.json()).toEqual({ ok: true, redirect: '/login' });
  });

  // Pocket ID's end-session returns to a bare /login; the sign-in page reads next from here.
  const nextCookie = (res: Response) =>
    res.headers.getSetCookie().find((line) => line.startsWith('wallet-next='));
  const logout = (jar: Jar, next: string) =>
    h.call(`/auth/logout?next=${encodeURIComponent(next)}`, { method: 'POST', cookies: jar });

  it('keeps a safe next through Pocket ID in a short-lived cookie only /login sees', async () => {
    const { jar } = await signIn(['user']);
    const res = await logout(jar, '/auth/magic?t=abc');
    expect(res.headers.get('location')).toContain('/api/oidc/end-session');
    const cookie = nextCookie(res) ?? '';
    expect(cookie).toContain(`wallet-next=${encodeURIComponent('/auth/magic?t=abc')};`);
    expect(cookie).toMatch(/Max-Age=300/);
    expect(cookie).toMatch(/Path=\/login/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/HttpOnly/);
  });

  it('drops an unsafe next, and needs no cookie when the URL keeps next', async () => {
    const unsafe = await logout((await signIn(['user'])).jar, '//evil.example/x');
    expect(nextCookie(unsafe)).toMatch(/^wallet-next=;.*Max-Age=0/);
    const { user } = await open(['user']);
    const ctx = createServiceContext(h.env, { clock });
    const magic = await createSession(ctx, {
      userId: user.id,
      roles: ['user'],
      amr: 'magic_link',
      ipPrefix: null,
      userAgent: null,
    });
    const res = await logout(new Map([['__Host-wallet_sid', magic.cookieValue]]), '/account');
    expect(res.headers.get('location')).toBe('/login?next=%2Faccount');
    expect(nextCookie(res)).toMatch(/Max-Age=0/);
  });
});
