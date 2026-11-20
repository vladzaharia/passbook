import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeOrg } from '../../../../test/helpers/factories.ts';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, run } from '../../platform/db.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type Jar, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const person = (groups: string[]) => {
  const id = `${++n}-${Math.random().toString(36).slice(2, 8)}`;
  return { sub: `land-${id}`, email: `land${id}@example.test`, name: 'Person', groups };
};
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));
const loginNext = (next: string) => `/login?next=${encodeURIComponent(next)}`;
const session = async (jar: Jar) =>
  (await (await h.call('/api/v1/session', { cookies: jar })).json()) as {
    authenticated: boolean;
    csrfToken: string;
    user: { id: string };
  };

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
  await setOidcTrust(h.env.DB, true);
});
afterEach(() => h.restore());

describe('landing after Polaris ID', () => {
  it('sends admins to the console and holders to My passes when there is no next', async () => {
    const admin = await oidcSignIn(h, new Map(), person(['wallet-admins']));
    expect(admin.res.headers.get('location')).toBe('/admin');
    const holder = await oidcSignIn(h, new Map(), person(['wallet-users']));
    expect(holder.res.headers.get('location')).toBe('/');
    const asked = await oidcSignIn(h, new Map(), person(['wallet-admins']), { next: '/' });
    expect(asked.res.headers.get('location')).toBe('/');
  });

  it('sends org members to the console, still honouring next', async () => {
    const who = person(['wallet-users']);
    const jar = new Map();
    await oidcSignIn(h, jar, who);
    const { user } = await session(jar);
    const org = await makeOrg(fixtures(h.env));
    const now = h.clock.now();
    await run(
      h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES ('inv-l', ?, ?, '["org_admin"]', 'th-l', ?, ?, ?)`,
      [org.id, who.email, now, now + 3600_000, now],
    );
    await run(
      h.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES ('mem-l', ?, ?, 'inv-l', '["org_admin"]', ?)`,
      [org.id, user.id, now],
    );
    const member = await oidcSignIn(h, new Map(), who);
    expect(member.res.headers.get('location')).toBe('/admin');
    const asked = await oidcSignIn(h, new Map(), who, { next: '/' });
    expect(asked.res.headers.get('location')).toBe('/');
  });

  it('keeps next on the way back from a cancelled sign-in', async () => {
    const { res } = await oidcSignIn(h, new Map(), person(['wallet-users']), {
      next: '/passes/3',
      tamperCallback: (u) => u.searchParams.set('error', 'access_denied'),
    });
    expect(res.status).toBe(400);
    expect(hrefs(await res.text())).toContain(loginNext('/passes/3'));
  });

  it('keeps next through the no-access page', async () => {
    const { res } = await oidcSignIn(h, new Map(), person(['other']), { next: '/admin/passes' });
    expect(res.headers.get('location')).toBe(
      `/auth/no-access?next=${encodeURIComponent('/admin/passes')}`,
    );
    const html = await (await h.call(res.headers.get('location') ?? '')).text();
    const links = hrefs(html);
    expect(links).toContain(`/login?focus=email&next=${encodeURIComponent('/admin/passes')}`);
    expect(links).toContain(
      `/auth/oidc/start?prompt=login&next=${encodeURIComponent('/admin/passes')}`,
    );
    const unsafe = hrefs(await (await h.call('/auth/no-access?next=//evil.example')).text());
    expect(unsafe).toContain('/login?focus=email');
    expect(unsafe.some((l) => l.includes('evil'))).toBe(false);
  });
});

describe('sign out', () => {
  it('carries a safe next to the sign-in page when no provider logout applies', async () => {
    const res = await h.call(`/auth/logout?next=${encodeURIComponent('/admin/users')}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(await res.json()).toEqual({ ok: true, redirect: loginNext('/admin/users') });
    const unsafe = await h.call('/auth/logout?next=https://evil.example', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(await unsafe.json()).toEqual({ ok: true, redirect: '/login' });
  });

  it('everywhere: needs the CSRF token, revokes every session, still leaves via Pocket ID', async () => {
    const user = person(['wallet-users']);
    const here: Jar = new Map();
    const there: Jar = new Map();
    await oidcSignIn(h, here, user);
    await oidcSignIn(h, there, { ...user });
    const { csrfToken, user: me } = await session(here);

    const refused = await h.call('/auth/logout?all=1', {
      method: 'POST',
      cookies: new Map(here),
      headers: { accept: 'application/json' },
    });
    await expectProblem(refused, 403, 'CSRF_TOKEN');
    expect((await session(there)).authenticated).toBe(true);

    const res = await h.call('/auth/logout?all=1', {
      method: 'POST',
      cookies: here,
      headers: { accept: 'application/json', 'x-csrf-token': csrfToken },
    });
    const body = (await res.json()) as { redirect: string };
    expect(body.redirect).toContain(`${ISSUER}/api/oidc/end-session`);
    expect(here.has('__Host-wallet_sid')).toBe(false);
    expect((await session(there)).authenticated).toBe(false);
    const audit = await all<{ action: string }>(
      h.env.DB,
      "SELECT action FROM audit_log WHERE actor_id = ? AND action = 'user.sessions_revoke'",
      [me.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('a form post refused for CSRF gets a page', async () => {
    const res = await h.call('/auth/logout?all=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
