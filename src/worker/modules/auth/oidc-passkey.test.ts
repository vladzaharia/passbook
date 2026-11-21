import { afterEach, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { oidcSignIn } from './test-oidc.ts';
import { absorb, harness, ISSUER, type Jar, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const person = (amr?: string[]) => {
  const id = `${++n}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    sub: `pk-${id}`,
    email: `pk${id}@example.test`,
    name: 'Person',
    groups: ['wallet_users'],
    ...(amr ? { amr } : {}),
  };
};

async function setup(overrides: Record<string, string> = {}) {
  await resetOidcClientCaches(ISSUER);
  h = await harness({ OIDC_REQUIRE_AMR: 'phr', ...overrides });
  await setOidcTrust(h.env.DB, true);
}
afterEach(() => h.restore());

const lastSession = () =>
  first<{ amr: string; auth_time: number | null }>(
    h.env.DB,
    'SELECT amr, auth_time FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );

/** From a callback's redirect to the provider: authorize as `user`, then call back. */
async function followToProvider(res: Response, jar: Jar, user: { sub: string }) {
  const loc = new URL(res.headers.get('location') ?? '');
  expect(loc.origin).toBe(ISSUER);
  loc.searchParams.set('login_hint', user.sub);
  const authz = await h.oidc.handle(new Request(loc.toString().replace(ISSUER, 'http://mock')));
  const cb = new URL(authz.headers.get('location') ?? '');
  const out = await h.call(`${cb.pathname}${cb.search}`, { cookies: jar });
  absorb(jar, out);
  return { loc, out };
}

describe('Polaris ID needs a passkey', () => {
  it('signs in with a passkey and keeps the provider auth_time', async () => {
    await setup();
    const jar: Jar = new Map();
    const { res } = await oidcSignIn(h, jar, person(['phr']));
    expect(res.status).toBe(302);
    const row = await lastSession();
    expect(row?.amr).toBe('oidc');
    expect(row?.auth_time).toBe(Math.floor(h.clock.now() / 1000) * 1000);
  });

  it('restarts once with prompt=login when the sign-in used a login code', async () => {
    await setup();
    const jar: Jar = new Map();
    const user = person(['otp']);
    const { res } = await oidcSignIn(h, jar, user);
    expect(res.status).toBe(302);
    absorb(jar, res);
    const again = new URL(res.headers.get('location') ?? '');
    expect(again.searchParams.get('prompt')).toBe('login');
    // The person uses their passkey the second time.
    h.oidc.addUser({ ...user, amr: ['phr'] });
    const { out } = await followToProvider(res, jar, user);
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/');
    expect((await lastSession())?.amr).toBe('oidc');
  });

  it('refuses with PASSKEY_REQUIRED when the second try is a code again, and signs nobody in', async () => {
    await setup();
    const jar: Jar = new Map();
    const user = person(['otp']);
    const { res } = await oidcSignIn(h, jar, user);
    absorb(jar, res);
    const before = await first<{ n: number }>(h.env.DB, 'SELECT count(*) AS n FROM sessions');
    const { out } = await followToProvider(res, jar, user);
    expect(out.status).toBe(403);
    const html = await out.text();
    expect(html).toContain('Use your passkey');
    expect(html).toContain('not a code');
    expect(jar.get('__Host-wallet_sid')).toBeUndefined();
    expect((await first<{ n: number }>(h.env.DB, 'SELECT count(*) AS n FROM sessions'))?.n).toBe(
      before?.n,
    );
  });

  it('accepts a code when OIDC_REQUIRE_AMR is empty', async () => {
    await setup({ OIDC_REQUIRE_AMR: '' });
    const { res } = await oidcSignIn(h, new Map(), person(['otp']));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
});
