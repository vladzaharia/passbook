import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fixtures,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { signInOidc } from './oidc-sign-in.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { linkIdentityByMail, type OidcClaims } from './service.ts';
import { oidcSignIn } from './test-oidc.ts';
import {
  fakeLimiter,
  harness,
  ISSUER,
  type Jar,
  type TestHarness,
  waitingPass,
} from './test-support.ts';

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

const setTrust = (on: boolean | null) => setOidcTrust(h.env.DB, on);

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
  // Mock Pocket ID verifies its emails; most tests want a first sign-in to need no mail round trip.
  await setTrust(true);
});
afterEach(async () => {
  h.restore();
  await setTrust(null);
});

describe('oidc sign-in', () => {
  it('signs an admin in and stores only hashes', async () => {
    await setTrust(true);
    const jar: Jar = new Map();
    const user = person(['wallet_admins']);
    const { res, start } = await oidcSignIn(h, jar, user);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('code_challenge_method=S256');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const body = (await session(jar)) as {
      authenticated: boolean;
      roles: string[];
      csrfToken: string;
    };
    expect(body.authenticated).toBe(true);
    expect(body.roles).toEqual(['admin', 'user', 'developer', 'console']);
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
    await oidcSignIn(h, jar, person(['wallet_users']));
    expect(((await session(jar)) as { roles: string[] }).roles).toEqual(['user']);
  });

  it('matches the group name exactly: a hyphenated claim is not the underscore name', async () => {
    const refused = await oidcSignIn(h, new Map(), person(['wallet-admins']));
    expect(refused.res.status).toBe(303);
  });

  it('refuses users in neither group and creates nothing', async () => {
    const jar: Jar = new Map();
    const user = person(['other']);
    const { res } = await oidcSignIn(h, jar, user);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/no-access');
    expect(jar.has('__Host-wallet_sid')).toBe(false);
    const page = await h.call('/auth/no-access');
    const html = await page.text();
    expect(html).toContain('This Polaris ID account cannot use PassBook.');
    expect(html).toContain('href="/login?focus=email"');
    expect(html).toContain('href="/auth/oidc/start?prompt=login"');
    expect(html).toContain('class="card" data-state="no-access"');
    expect(
      await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [user.email]),
    ).toBeNull();
  });

  it('asks the provider to sign in again for another account', async () => {
    const start = await h.call('/auth/oidc/start?prompt=login');
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('prompt')).toBe('login');
    const plain = await h.call('/auth/oidc/start');
    expect(new URL(plain.headers.get('location') ?? '').searchParams.has('prompt')).toBe(false);
  });

  it('passes max_age=0 to the provider for a step-up, and only then', async () => {
    const start = await h.call('/auth/oidc/start?prompt=login&max_age=0&next=%2Fadmin%2Fapi-keys');
    const url = new URL(start.headers.get('location') ?? '');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    for (const q of ['max_age=600', 'max_age=-1', 'max_age=x'])
      expect(
        new URL(
          (await h.call(`/auth/oidc/start?${q}`)).headers.get('location') ?? '',
        ).searchParams.has('max_age'),
      ).toBe(false);
  });

  it('never grants a role whose group variable is unset', async () => {
    h.restore();
    h = await harness({ OIDC_PLATFORM_ADMIN_GROUP: '' });
    const jar: Jar = new Map();
    expect((await oidcSignIn(h, jar, person(['wallet_admins']))).res.status).toBe(303);
    expect((await oidcSignIn(h, jar, person(['wallet_admins', 'wallet_users']))).res.status).toBe(
      302,
    );
    expect(((await session(jar)) as { roles: string[] }).roles).toEqual(['user']);
    h.restore();
    h = await harness({ OIDC_PLATFORM_ADMIN_GROUP: '', OIDC_USER_GROUP: '' });
    expect(
      (await oidcSignIn(h, new Map(), person(['wallet_users', 'wallet_admins']))).res.status,
    ).toBe(303);
  });

  it('links a new subject to the user who owns the email', async () => {
    await setTrust(true);
    const f = fixtures(h.env);
    const existing = await makeUser(f);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, person(['wallet_users'], { email: existing.primaryEmail }));
    const body = (await session(jar)) as { user: { id: string } };
    expect(body.user.id).toBe(existing.id);
    const identities = await all(h.env.DB, 'SELECT 1 FROM auth_identities WHERE user_id = ?', [
      existing.id,
    ]);
    expect(identities).toHaveLength(1);
  });

  it('keys identity on subject, not email', async () => {
    const user = person(['wallet_users']);
    const first1 = new Map() as Jar;
    await oidcSignIn(h, first1, user);
    const id1 = ((await session(first1)) as { user: { id: string } }).user.id;
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, {
      ...user,
      email: `changed-${uniq()}@example.test`,
      groups: ['wallet_admins'],
    });
    const body = (await session(jar)) as { user: { id: string }; roles: string[] };
    expect(body.user.id).toBe(id1);
    expect(body.roles).toEqual(['admin', 'user', 'developer', 'console']);
    const row = await first<{ groups: string }>(
      h.env.DB,
      'SELECT groups FROM auth_identities WHERE subject = ?',
      [user.sub],
    );
    expect(JSON.parse(row?.groups ?? '[]')).toEqual(['wallet_admins']);
  });

  it('does not take an email owned by another account for an existing identity', async () => {
    const f = fixtures(h.env);
    const owner = await makeUser(f);
    const jar: Jar = new Map();
    const user = person(['wallet_users']);
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

  it('attaches passes waiting for the sign-in email and writes auth.sign_in', async () => {
    await setTrust(true);
    h.restore();
    const points: { blobs: string[] }[] = [];
    h = await harness({
      EVENTS: { writeDataPoint: (p: { blobs: string[] }) => points.push(p) } as never,
    });
    const user = person(['wallet_users']);
    const pass = await waitingPass(user.email);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, user);
    const me = (await session(jar)) as { user: { id: string } };
    const row = await first<{ owner_user_id: string | null }>(
      h.env.DB,
      'SELECT owner_user_id FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.owner_user_id).toBe(me.user.id);
    const signIns = points.filter((p) => p.blobs[0] === 'auth.sign_in');
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.blobs[4]).toBe('oidc');
  });

  it('limits start and callback per IP with RL_LOGIN', async () => {
    h.restore();
    const limiter = fakeLimiter(1);
    h = await harness({ RL_LOGIN: limiter as unknown as RateLimit });
    const ip = (value: string) => ({ headers: { 'cf-connecting-ip': value } });
    expect((await h.call('/auth/oidc/start', ip('1.1.1.1'))).status).toBe(302);
    const limited = await h.call('/auth/oidc/start', ip('1.1.1.1'));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect((await h.call('/auth/oidc/callback', ip('1.1.1.1'))).status).toBe(429);
    expect((await h.call('/auth/oidc/start', ip('2.2.2.2'))).status).toBe(302);
    expect([...limiter.calls.keys()]).toContain('oidc:1.1.1.0/24');
  });

  it('shares the RL_LOGIN bucket across an IPv4 /24 and an IPv6 /64', async () => {
    h.restore();
    h = await harness({ RL_LOGIN: fakeLimiter(1) as unknown as RateLimit });
    const start = async (ip: string) =>
      (await h.call('/auth/oidc/start', { headers: { 'cf-connecting-ip': ip } })).status;
    expect(await start('1.1.1.1')).toBe(302);
    expect(await start('1.1.1.200')).toBe(429);
    expect(await start('2001:db8:1:2::1')).toBe(302);
    expect(await start('2001:db8:1:2:ffff::9')).toBe(429);
    expect(await start('2001:db8:1:3::1')).toBe(302);
  });

  describe('oidc.trustEmail off (default)', () => {
    beforeEach(() => setTrust(null));

    it('proves an existing email owner by mail before linking', async () => {
      const f = fixtures(h.env);
      const existing = await makeUser(f);
      const jar: Jar = new Map();
      const user = person(['wallet_users'], { email: existing.primaryEmail });
      const { res } = await oidcSignIn(h, jar, user);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Check your email');
      expect(h.mail).toHaveLength(1);
      expect(h.mail[0]?.to).toBe(existing.primaryEmail);
      expect(
        await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [user.sub]),
      ).toBeNull();
      expect(jar.has('__Host-wallet_sid')).toBe(false);
      const token = /t=([\w-]+)/.exec(h.mail[0]?.text ?? '')?.[1] ?? '';
      const consume = (cookies: Jar) =>
        h.call('/auth/magic/consume', {
          method: 'POST',
          body: new URLSearchParams({ token }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          cookies,
        });
      expect((await consume(new Map())).status).toBe(400);
      const consumed = await consume(jar);
      expect(consumed.status).toBe(303);
      expect(consumed.headers.get('location')).toBe('/auth/oidc/start');
      expect(consumed.headers.getSetCookie().join(';')).not.toContain('wallet_sid');
      const row = await first<{ user_id: string }>(
        h.env.DB,
        'SELECT user_id FROM auth_identities WHERE subject = ?',
        [user.sub],
      );
      expect(row?.user_id).toBe(existing.id);
      const linked = await all<{ detail: string }>(
        h.env.DB,
        "SELECT detail FROM audit_log WHERE action = 'auth.identity_linked' AND target_id = ?",
        [existing.id],
      );
      expect(linked.map((r) => JSON.parse(r.detail).via)).toEqual(['mail_proof']);
      expect(linked[0]?.detail).not.toContain(existing.primaryEmail);
      h.mail.length = 0;
      const again = await oidcSignIn(h, new Map(), user);
      expect(again.res.status).toBe(302);
      expect(h.mail).toHaveLength(0);
    });

    it('proves a new subject by mail and creates nothing from the claim', async () => {
      const user = person(['wallet_users']);
      const { res } = await oidcSignIn(h, new Map(), user);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Check your email');
      expect(h.mail.at(-1)?.to).toBe(user.email);
      expect(
        await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [user.email]),
      ).toBeNull();
      expect(
        await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [user.email]),
      ).toBeNull();
      expect(
        await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [user.sub]),
      ).toBeNull();
    });
  });

  it.each([undefined, false, 'true', 1, null, {}, ['true']])(
    'sends mail proof for unsupported email verification claim %j instead of creating or linking',
    async (claim) => {
      await setTrust(true);
      const existing = await makeUser(fixtures(h.env));
      const ctx = createServiceContext(h.env, { clock: h.clock });
      for (const email of [existing.primaryEmail, `unclaimed-${uniq()}@example.test`]) {
        const user = person(['wallet_users'], { email });
        const claims = {
          ...user,
          emailVerified: claim,
        } as unknown as OidcClaims;
        const mailBefore = h.mail.length;
        await expect(
          signInOidc(ctx, claims, { ipPrefix: null, userAgent: null, bindingHash: 'b'.repeat(64) }),
        ).rejects.toMatchObject({ code: 'EMAIL_PROOF_SENT' });
        expect(h.mail).toHaveLength(mailBefore + 1);
        expect(h.mail.at(-1)?.to).toBe(email);
        expect(
          await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [user.sub]),
        ).toBeNull();
        if (email !== existing.primaryEmail) {
          expect(
            await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [email]),
          ).toBeNull();
        }
      }
    },
  );

  it('allows an existing identity to sign in without attaching passes from an unverified claim', async () => {
    await setTrust(true);
    const user = person(['wallet_users']);
    const firstJar: Jar = new Map();
    expect((await oidcSignIn(h, firstJar, user)).res.status).toBe(302);
    const id = ((await session(firstJar)) as { user: { id: string } }).user.id;
    const f = fixtures(h.env);
    const org = await makeOrg(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate().resolved,
      holderEmail: user.email,
    });
    const jar: Jar = new Map();
    const { res } = await oidcSignIn(h, jar, { ...user, emailVerified: false });
    expect(res.status).toBe(302);
    expect(((await session(jar)) as { user: { id: string } }).user.id).toBe(id);
    expect(
      (
        await first<{ owner_user_id: string | null }>(
          h.env.DB,
          'SELECT owner_user_id FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.owner_user_id,
    ).toBeNull();
  });

  it('links an unverified OIDC identity once its mail proof is consumed', async () => {
    const existing = await makeUser(fixtures(h.env));
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const subject = `proof-${uniq()}`;
    await linkIdentityByMail(
      ctx,
      existing.primaryEmail,
      {
        provider: 'pocketid',
        subject,
        emailClaim: existing.primaryEmail,
        emailVerified: false,
        groups: ['wallet_users'],
      },
      { ipPrefix: null, userAgent: null },
    );
    expect(
      await first(
        h.env.DB,
        'SELECT user_id, email_verified FROM auth_identities WHERE subject = ?',
        [subject],
      ),
    ).toEqual({ user_id: existing.id, email_verified: 0 });
  });

  describe('oidc.trustEmail on', () => {
    it('proves an unverified claim by mail without linking or signing in', async () => {
      await setTrust(true);
      const existing = await makeUser(fixtures(h.env));
      const jar: Jar = new Map();
      const user = {
        ...person(['wallet_users'], { email: existing.primaryEmail }),
        emailVerified: false,
      };
      const { res } = await oidcSignIn(h, jar, user);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Check your email');
      expect(h.mail).toHaveLength(1);
      expect(jar.has('__Host-wallet_sid')).toBe(false);
      expect(
        await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [user.sub]),
      ).toBeNull();
    });

    it('links a verified claim and audits the link without the email', async () => {
      await setTrust(true);
      const existing = await makeUser(fixtures(h.env));
      const user = {
        ...person(['wallet_users'], { email: existing.primaryEmail }),
        emailVerified: true,
      };
      const { res } = await oidcSignIn(h, new Map(), user);
      expect(res.status).toBe(302);
      const rows = await all<{ detail: string }>(
        h.env.DB,
        "SELECT detail FROM audit_log WHERE action = 'auth.identity_linked' AND target_id = ?",
        [existing.id],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
        provider: 'pocketid',
        via: 'trusted_email',
        emailVerified: true,
      });
      expect(rows[0]?.detail).not.toContain(existing.primaryEmail);
    });

    it('sends mail proof to an unverified new identity without attaching waiting passes', async () => {
      await setTrust(true);
      const f1 = fixtures(h.env);
      const org = await makeOrg(f1);
      const user = { ...person(['wallet_users']), emailVerified: false };
      const pass = await makePass(f1, {
        orgId: org.id,
        template: makeTemplate().resolved,
        holderEmail: user.email,
      });
      const { res } = await oidcSignIn(h, new Map(), user);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Check your email');
      expect(h.mail).toHaveLength(1);
      expect(h.mail[0]?.to).toBe(user.email);
      const row = await first<{ owner_user_id: string | null }>(
        h.env.DB,
        'SELECT owner_user_id FROM passes WHERE id = ?',
        [pass.id],
      );
      expect(row?.owner_user_id).toBeNull();
      expect(
        await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [user.email]),
      ).toBeNull();
    });
  });

  it('refuses disabled users and rejects their live sessions', async () => {
    const user = person(['wallet_users']);
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
    const user = person(['wallet_users']);
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
      const { res } = await oidcSignIn(h, new Map(), person(['wallet_users']), {
        next: '/passes/1?a=b',
      });
      expect(res.headers.get('location')).toBe('/passes/1?a=b');
    });

    it.each(['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
      'drops %s',
      async (next) => {
        const { res } = await oidcSignIn(h, new Map(), person(['wallet_users']), { next });
        expect(res.headers.get('location')).toBe('/');
      },
    );
  });

  describe('callback checks', () => {
    it('rejects a wrong state', async () => {
      const jar: Jar = new Map();
      const { res } = await oidcSignIn(h, jar, person(['wallet_users']), {
        tamperCallback: (u) => u.searchParams.set('state', 'forged'),
      });
      expect(res.status).toBe(400);
      expect(jar.has('__Host-wallet_sid')).toBe(false);
    });

    it('rejects a callback without the binding cookie and keeps the flow', async () => {
      const user = person(['wallet_users']);
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
      const user = person(['wallet_users']);
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
      const { res } = await oidcSignIn(h, jar, person(['wallet_users']), {
        tamper: (u) => u.searchParams.set('nonce', 'attacker-nonce'),
      });
      expect(res.status).toBe(400);
      expect(jar.has('__Host-wallet_sid')).toBe(false);
    });

    it('rejects a mismatched or missing iss', async () => {
      const a = await oidcSignIn(h, new Map(), person(['wallet_users']), {
        tamperCallback: (u) => u.searchParams.set('iss', 'https://evil.example'),
      });
      expect(a.res.status).toBe(400);
      const b = await oidcSignIn(h, new Map(), person(['wallet_users']), {
        tamperCallback: (u) => u.searchParams.delete('iss'),
      });
      expect(b.res.status).toBe(400);
    });

    it('rejects an error response and a missing code', async () => {
      const a = await oidcSignIn(h, new Map(), person(['wallet_users']), {
        tamperCallback: (u) => u.searchParams.set('error', 'access_denied'),
      });
      expect(a.res.status).toBe(400);
      const b = await oidcSignIn(h, new Map(), person(['wallet_users']), {
        tamperCallback: (u) => u.searchParams.delete('code'),
      });
      expect(b.res.status).toBe(400);
    });

    it('rejects a PKCE failure at the provider', async () => {
      const res = await oidcSignIn(h, new Map(), person(['wallet_users']), {
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
    h = await harness({ OIDC_CLIENT_ID: '' });
    expect((await h.call('/auth/oidc/start')).status).toBe(503);
    const body = (await session(new Map())) as { oidcEnabled: boolean };
    expect(body.oidcEnabled).toBe(false);
  });

  describe('logout', () => {
    it('revokes the session and leaves through end_session_endpoint', async () => {
      const jar: Jar = new Map();
      await oidcSignIn(h, jar, person(['wallet_users']));
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
      await oidcSignIn(h, jar, person(['wallet_users']));
      const res = await h.call('/auth/logout', { method: 'POST', cookies: jar });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('/api/oidc/end-session');
    });

    it('refuses cross-origin logout posts', async () => {
      const res = await h.call('/auth/logout', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      await expectProblem(res, 403, 'CSRF_ORIGIN');
    });
  });

  it('passes the subject to the platform admin pin: listed is admin, unlisted is not', async () => {
    const env = h.env as unknown as Record<string, string | undefined>;
    const saved = env.OIDC_PLATFORM_ADMIN_SUBJECTS;
    const listed = person(['wallet_admins']);
    const other = person(['wallet_admins']);
    env.OIDC_PLATFORM_ADMIN_SUBJECTS = `sub-none, ${listed.sub}`;
    try {
      const ctx = createServiceContext(h.env, { clock: h.clock });
      const sign = { ipPrefix: null, userAgent: null, bindingHash: 'b'.repeat(64) };
      const asAdmin = await signInOidc(ctx, { ...listed, emailVerified: true }, sign);
      expect(asAdmin.roles).toContain('admin');
      await expect(signInOidc(ctx, { ...other, emailVerified: true }, sign)).rejects.toMatchObject({
        code: 'NO_ACCESS',
      });
    } finally {
      env.OIDC_PLATFORM_ADMIN_SUBJECTS = saved;
    }
  });
});
