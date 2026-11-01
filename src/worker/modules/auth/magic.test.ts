import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { fakeLimiter, harness, type Jar, type SentMail, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const uniq = () => `${++n}${Math.random().toString(36).slice(2, 8)}`;
const addr = () => `m${uniq()}@example.test`;
const f = () => fixtures(h.env);

const tokenOf = (m: SentMail | undefined) => /t=([\w-]+)/.exec(m?.text ?? '')?.[1] ?? '';
const codeOf = (m: SentMail | undefined) => /Code: (\d{6})/.exec(m?.text ?? '')?.[1] ?? '';

const requestLink = (email: string, jar: Jar = new Map(), extra: object = {}) =>
  h.call('/auth/magic/request', {
    method: 'POST',
    json: { email, turnstileToken: 'ok', ...extra },
    cookies: jar,
  });
const consumeForm = (token: string, jar: Jar = new Map()) =>
  h.call('/auth/magic/consume', {
    method: 'POST',
    body: new URLSearchParams({ token }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookies: jar,
  });
const consumeCode = (email: string, code: string, jar: Jar) =>
  h.call('/auth/magic/consume', { method: 'POST', json: { email, code }, cookies: jar });
const session = async (jar: Jar) =>
  (await h.call('/api/v1/session', { cookies: jar })).json() as Promise<{
    authenticated: boolean;
    roles: string[];
    amr: string;
    csrfToken: string;
    user: { id: string; primaryEmail: string };
  }>;

const ownerOf = async (passId: string) =>
  (
    await first<{ owner_user_id: string | null }>(
      h.env.DB,
      'SELECT owner_user_id FROM passes WHERE id = ?',
      [passId],
    )
  )?.owner_user_id;

async function knownEmail() {
  return (await makeUser(f())).primaryEmail;
}

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

describe('request', () => {
  it('mails a link and code to a known address and binds the browser', async () => {
    const email = await knownEmail();
    const jar: Jar = new Map();
    const res = await requestLink(email, jar);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]?.to).toBe(email);
    expect(h.mail[0]?.html).toContain('lang="en"');
    expect(codeOf(h.mail[0])).toMatch(/^\d{6}$/);
    expect(jar.has('__Host-wallet_ml')).toBe(true);
    const token = tokenOf(h.mail[0]);
    const rows = await all<{ token_hash: string; code_hash: string }>(
      h.env.DB,
      'SELECT token_hash, code_hash FROM magic_links WHERE email = ?',
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.code_hash).not.toContain(codeOf(h.mail[0]));
  });

  it('mails an address that holds a pass but has no account', async () => {
    const f1 = f();
    const org = await makeOrg(f1);
    const email = addr();
    await makePass(f1, { orgId: org.id, template: makeTemplate().resolved, holderEmail: email });
    await requestLink(email);
    expect(h.mail).toHaveLength(1);
  });

  it('answers unknown addresses identically and sends nothing', async () => {
    const known = await requestLink(await knownEmail(), new Map());
    const unknownJar: Jar = new Map();
    const unknown = await requestLink(addr(), unknownJar);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    expect(unknownJar.has('__Host-wallet_ml')).toBe(true);
    expect(h.mail).toHaveLength(1);
  });

  it('fails closed on a bad Turnstile token or verifier failure', async () => {
    const email = await knownEmail();
    const bad = await requestLink(email, new Map(), { turnstileToken: 'nope' });
    expect(bad.status).toBe(403);
    h.turnstileOk.value = false;
    expect((await requestLink(email)).status).toBe(403);
    expect(h.mail).toHaveLength(0);
  });

  it('rejects malformed input before anything else', async () => {
    expect((await requestLink('not-an-email')).status).toBe(422);
    expect(
      (await h.call('/auth/magic/request', { method: 'POST', json: { email: addr() } })).status,
    ).toBe(422);
  });

  it('is limited per IP', async () => {
    h.restore();
    h = await harness({ RL_MAGIC_LINK: fakeLimiter(1) as unknown as RateLimit });
    const email = await knownEmail();
    expect((await requestLink(email)).status).toBe(202);
    expect((await requestLink(email)).status).toBe(429);
  });

  it('caps links per address per hour without changing the response', async () => {
    const email = await knownEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await requestLink(email)).status);
    expect(new Set(statuses)).toEqual(new Set([202]));
    expect(h.mail).toHaveLength(5);
  });

  it('caps sends per network per day, and other networks are unaffected', async () => {
    const ip = (n: number) => ({ headers: { 'cf-connecting-ip': `203.0.113.${n}` } });
    const send = async (n: number) =>
      h.call('/auth/magic/request', {
        method: 'POST',
        json: { email: await knownEmail(), turnstileToken: 'ok' },
        ...ip(n),
      });
    for (let i = 0; i < 31; i++) expect((await send(i % 200)).status).toBe(202);
    expect(h.mail).toHaveLength(30);
    expect((await send(7)).status).toBe(202);
    expect(h.mail).toHaveLength(30);
    const other = await h.call('/auth/magic/request', {
      method: 'POST',
      json: { email: await knownEmail(), turnstileToken: 'ok' },
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(other.status).toBe(202);
    expect(h.mail).toHaveLength(31);
  });

  it('honours the daily cap and does not count unknown addresses against it', async () => {
    h.restore();
    h = await harness({ MAGIC_LINK_DAILY_CAP: '2' });
    await run(h.env.DB, "DELETE FROM counters WHERE key = 'magic:daily'");
    for (let i = 0; i < 4; i++) await requestLink(addr());
    expect(h.mail).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect((await requestLink(await knownEmail())).status).toBe(202);
    expect(h.mail).toHaveLength(2);
  });

  it('keeps an earlier link live when another request arrives', async () => {
    const email = await knownEmail();
    await requestLink(email);
    await requestLink(email);
    expect((await consumeForm(tokenOf(h.mail[0]))).status).toBe(303);
    expect((await consumeForm(tokenOf(h.mail[1]))).status).toBe(303);
  });

  it('keeps the browser binding stable across requests', async () => {
    const email = await knownEmail();
    const jar: Jar = new Map();
    await requestLink(email, jar);
    const first = jar.get('__Host-wallet_ml');
    await requestLink(email, jar);
    expect(jar.get('__Host-wallet_ml')).toBe(first);
    expect((await consumeCode(email, codeOf(h.mail[1]), jar)).status).toBe(200);
  });

  it('does not spend an address budget on unknown addresses', async () => {
    const email = addr();
    for (let i = 0; i < 6; i++) await requestLink(email);
    const key = `magic:email:${(await sha256Hex(`magic-email:${email}`)).slice(0, 32)}`;
    expect(await first(h.env.DB, 'SELECT 1 FROM counters WHERE key = ?', [key])).toBeNull();
  });

  it('checks the setting before Turnstile', async () => {
    await run(
      h.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.magicLinkEnabled', 'false', 0)",
    );
    clearSettingsCache(h.env.DB);
    let siteverify = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes('challenges.cloudflare.com')) siteverify++;
      return real(input, init);
    }) as typeof fetch;
    try {
      expect((await requestLink(addr())).status).toBe(503);
    } finally {
      globalThis.fetch = real;
      await run(h.env.DB, "DELETE FROM settings WHERE key = 'auth.magicLinkEnabled'");
      clearSettingsCache(h.env.DB);
    }
    expect(siteverify).toBe(0);
  });

  it('refuses to consume a sign-in link once the setting is off', async () => {
    const email = await knownEmail();
    await requestLink(email);
    await run(
      h.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.magicLinkEnabled', 'false', 0)",
    );
    clearSettingsCache(h.env.DB);
    try {
      expect((await consumeForm(tokenOf(h.mail[0]))).status).toBe(503);
    } finally {
      await run(h.env.DB, "DELETE FROM settings WHERE key = 'auth.magicLinkEnabled'");
      clearSettingsCache(h.env.DB);
    }
  });

  it('is refused when email sign-in is off', async () => {
    await run(
      h.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.magicLinkEnabled', 'false', 0)",
    );
    clearSettingsCache(h.env.DB);
    try {
      expect((await requestLink(await knownEmail())).status).toBe(503);
      const info = (await h.call('/api/v1/session')).json() as Promise<{
        magicLinkEnabled: boolean;
      }>;
      expect((await info).magicLinkEnabled).toBe(false);
    } finally {
      await run(h.env.DB, "DELETE FROM settings WHERE key = 'auth.magicLinkEnabled'");
      clearSettingsCache(h.env.DB);
    }
  });

  it('rejects cross-origin requests', async () => {
    const res = await h.call('/auth/magic/request', {
      method: 'POST',
      json: { email: addr(), turnstileToken: 'ok' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });
});

describe('consume limits', () => {
  it('limits consume per IP with RL_LOGIN', async () => {
    h.restore();
    const limiter = fakeLimiter(1);
    h = await harness({ RL_LOGIN: limiter as unknown as RateLimit });
    const post = (ip: string) =>
      h.call('/auth/magic/consume', {
        method: 'POST',
        json: { token: 'x'.repeat(32) },
        headers: { 'cf-connecting-ip': ip },
      });
    expect((await post('1.1.1.1')).status).toBe(400);
    const limited = await post('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect((await post('2.2.2.2')).status).toBe(400);
    expect([...limiter.calls.keys()]).toContain('magic:1.1.1.1');
  });

  it('rejects oversized bodies with 413 before parsing', async () => {
    const res = await h.call('/auth/magic/request', {
      method: 'POST',
      body: JSON.stringify({ email: addr(), turnstileToken: 'ok', pad: 'x'.repeat(20_000) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
  });
});

describe('confirm page and token', () => {
  it('shows a confirm form on GET without consuming the token', async () => {
    const email = await knownEmail();
    await requestLink(email);
    const token = tokenOf(h.mail[0]);
    for (let i = 0; i < 2; i++) {
      const page = await h.call(`/auth/magic?t=${token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('action="/auth/magic/consume"');
      expect(html).toContain(email);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect((await consumeForm(token)).status).toBe(303);
  });

  it('shows an error page for unknown, short and consumed tokens', async () => {
    const email = await knownEmail();
    await requestLink(email);
    const token = tokenOf(h.mail[0]);
    await consumeForm(token);
    for (const t of [token, 'x'.repeat(43), 'short', '']) {
      const page = await h.call(`/auth/magic?t=${t}`);
      expect(page.status).toBe(400);
    }
  });

  it('signs in from any browser, once, with the user role only', async () => {
    const email = await knownEmail();
    await requestLink(email, new Map());
    const token = tokenOf(h.mail[0]);
    const other: Jar = new Map();
    const res = await consumeForm(token, other);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const body = await session(other);
    expect(body.authenticated).toBe(true);
    expect(body.roles).toEqual(['user']);
    expect(body.amr).toBe('magic_link');
    const again = await consumeForm(token, new Map());
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('Link expired');
  });

  it('consumes atomically: parallel posts yield one session', async () => {
    const email = await knownEmail();
    await requestLink(email);
    const token = tokenOf(h.mail[0]);
    const results = await Promise.all([consumeForm(token), consumeForm(token), consumeForm(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 400, 400]);
  });

  it('creates an account for an address that only holds a pass', async () => {
    const f1 = f();
    const org = await makeOrg(f1);
    const email = addr();
    const pass = await makePass(f1, {
      orgId: org.id,
      template: makeTemplate().resolved,
      holderEmail: email,
    });
    await requestLink(email);
    const jar: Jar = new Map();
    await consumeForm(tokenOf(h.mail[0]), jar);
    const row = await first<{ verified_via: string }>(
      h.env.DB,
      'SELECT verified_via FROM user_emails WHERE email = ?',
      [email],
    );
    expect(row?.verified_via).toBe('magic_link');
    const me = await session(jar);
    expect(me.user.primaryEmail).toBe(email);
    expect(await ownerOf(pass.id)).toBe(me.user.id);
    const listed = (await h.call('/api/v1/me/passes', { cookies: jar })).json() as Promise<{
      items: { id: string }[];
    }>;
    expect((await listed).items.map((p) => p.id)).toEqual([pass.id]);
  });

  it('never grants admin, even to an account with an admin identity', async () => {
    const user = await makeUser(f());
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, groups, created_at) VALUES ('pocketid', ?, ?, '["wallet-admins"]', 0)`,
      [`s${uniq()}`, user.id],
    );
    await run(h.env.DB, `UPDATE users SET last_roles = '["admin","user"]' WHERE id = ?`, [user.id]);
    await requestLink(user.primaryEmail);
    const jar: Jar = new Map();
    await consumeForm(tokenOf(h.mail[0]), jar);
    expect((await session(jar)).roles).toEqual(['user']);
  });

  it('expires after 15 minutes', async () => {
    await requestLink(await knownEmail());
    h.clock.advance(16 * 60_000);
    const res = await consumeForm(tokenOf(h.mail[0]));
    expect(res.status).toBe(400);
  });

  it('refuses disabled accounts', async () => {
    const user = await makeUser(f());
    await requestLink(user.primaryEmail);
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    const jar: Jar = new Map();
    const res = await consumeForm(tokenOf(h.mail[0]), jar);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Account disabled');
    expect(jar.has('__Host-wallet_sid')).toBe(false);
  });

  it('refuses cross-site posts', async () => {
    const res = await h.call('/auth/magic/consume', {
      method: 'POST',
      body: new URLSearchParams({ token: 'x'.repeat(43) }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(res.status).toBe(403);
  });

  it('rejects an empty or malformed body', async () => {
    const res = await h.call('/auth/magic/consume', { method: 'POST', json: { nope: 1 } });
    expect(res.status).toBe(422);
  });

  describe('next', () => {
    it('returns to a same-origin path', async () => {
      await requestLink(await knownEmail(), new Map(), { next: '/passes/9' });
      const res = await consumeForm(tokenOf(h.mail[0]));
      expect(res.headers.get('location')).toBe('/passes/9');
    });

    it.each(['https://evil.example/', '//evil.example', '/\\evil.example'])(
      'drops %s',
      async (next) => {
        await requestLink(await knownEmail(), new Map(), { next });
        const res = await consumeForm(tokenOf(h.mail[0]));
        expect(res.headers.get('location')).toBe('/');
      },
    );
  });
});

describe('code', () => {
  async function pending() {
    const email = await knownEmail();
    const jar: Jar = new Map();
    await requestLink(email, jar);
    return { email, jar, code: codeOf(h.mail.at(-1)), token: tokenOf(h.mail.at(-1)) };
  }

  it('signs in from the requesting browser', async () => {
    const { email, jar, code } = await pending();
    const res = await consumeCode(email, code, jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/' });
    expect((await session(jar)).authenticated).toBe(true);
    expect(jar.has('__Host-wallet_ml')).toBe(false);
  });

  it('is refused from another browser even with the right code', async () => {
    const { email, code } = await pending();
    expect((await consumeCode(email, code, new Map())).status).toBe(400);
    expect((await consumeCode(email, code, new Map([['__Host-wallet_ml', 'guess']]))).status).toBe(
      400,
    );
  });

  it('is single use and dies with the link', async () => {
    const a = await pending();
    expect((await consumeCode(a.email, a.code, a.jar)).status).toBe(200);
    expect((await consumeCode(a.email, a.code, a.jar)).status).toBe(400);
    const b = await pending();
    await consumeForm(b.token);
    expect((await consumeCode(b.email, b.code, b.jar)).status).toBe(400);
  });

  it('allows five attempts, then locks the link', async () => {
    const { email, jar, code } = await pending();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await consumeCode(email, wrong, jar)).status).toBe(400);
    const fifth = await pending();
    const wrong5 = fifth.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await consumeCode(fifth.email, wrong5, fifth.jar);
    expect((await consumeCode(fifth.email, fifth.code, fifth.jar)).status).toBe(400);
    expect((await consumeCode(email, code, jar)).status).toBe(200);
  });

  it('locks code entry per address after ten failures, across new links', async () => {
    const email = await knownEmail();
    const jar: Jar = new Map();
    for (let round = 0; round < 3; round++) {
      await requestLink(email, jar);
      const wrong = codeOf(h.mail.at(-1)) === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) await consumeCode(email, wrong, jar);
    }
    await requestLink(email, jar);
    expect((await consumeCode(email, codeOf(h.mail.at(-1)), jar)).status).toBe(400);
    expect((await consumeForm(tokenOf(h.mail.at(-1)))).status).toBe(303);
  });

  it('is bound to the requested address', async () => {
    const a = await pending();
    const b = await pending();
    expect((await consumeCode(b.email, a.code, a.jar)).status).toBe(400);
  });

  it('expires with the link', async () => {
    const { email, jar, code } = await pending();
    h.clock.advance(16 * 60_000);
    expect((await consumeCode(email, code, jar)).status).toBe(400);
  });
});

describe('verify email', () => {
  async function signedIn() {
    const email = await knownEmail();
    const jar: Jar = new Map();
    await requestLink(email, jar);
    await consumeForm(tokenOf(h.mail[0]), jar);
    h.mail.length = 0;
    const s = await session(jar);
    return { jar, csrf: s.csrfToken, userId: s.user.id };
  }
  const add = (jar: Jar, csrf: string | null, email: string) =>
    h.call('/api/v1/me/emails', {
      method: 'POST',
      json: { email },
      cookies: jar,
      headers: csrf ? { 'x-csrf-token': csrf } : {},
    });

  it('requires the CSRF token', async () => {
    const { jar } = await signedIn();
    expect((await add(jar, null, addr())).status).toBe(403);
    expect((await add(jar, 'wrong', addr())).status).toBe(403);
    expect(h.mail).toHaveLength(0);
  });

  it('adds the address only after the link is confirmed, and attaches waiting passes', async () => {
    const { jar, csrf, userId } = await signedIn();
    const email = addr();
    const f1 = f();
    const org = await makeOrg(f1);
    const pass = await makePass(f1, {
      orgId: org.id,
      template: makeTemplate().resolved,
      holderEmail: email,
    });
    expect((await add(jar, csrf, email)).status).toBe(202);
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]?.subject).toBe('Confirm your email');
    expect(h.mail[0]?.text).toContain('account of');
    expect(codeOf(h.mail[0])).toBe('');
    expect(await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [email])).toBeNull();
    expect(await ownerOf(pass.id)).toBeFalsy();
    const res = await consumeForm(tokenOf(h.mail[0]), jar);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/account');
    const row = await first<{ user_id: string; verified_via: string }>(
      h.env.DB,
      'SELECT user_id, verified_via FROM user_emails WHERE email = ?',
      [email],
    );
    expect(row).toEqual({ user_id: userId, verified_via: 'magic_link' });
    expect(await ownerOf(pass.id)).toBe(userId);
  });

  it('names the requesting account on the confirm page', async () => {
    const { jar, csrf } = await signedIn();
    const requester = (await session(jar)).user.primaryEmail;
    await add(jar, csrf, addr());
    const page = await h.call(`/auth/magic?t=${tokenOf(h.mail[0])}`);
    expect(await page.text()).toContain(requester);
  });

  it('refuses a browser without the requester session and keeps the link', async () => {
    const { jar, csrf } = await signedIn();
    const email = addr();
    await add(jar, csrf, email);
    const token = tokenOf(h.mail[0]);
    h.mail.length = 0;
    const anon = await consumeForm(token, new Map());
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain('Sign in first');
    const other = await signedIn();
    expect((await consumeForm(token, other.jar)).status).toBe(403);
    expect(await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [email])).toBeNull();
    expect((await session(new Map())).authenticated).toBe(false);
    expect((await consumeForm(token, jar)).status).toBe(303);
  });

  it('stays silent for an address owned by another account', async () => {
    const { jar, csrf } = await signedIn();
    const other = await makeUser(f());
    expect((await add(jar, csrf, other.primaryEmail)).status).toBe(202);
    expect(h.mail).toHaveLength(0);
  });

  it('caps verification mails per address like public sign-in', async () => {
    const { jar, csrf } = await signedIn();
    const email = addr();
    for (let i = 0; i < 8; i++) expect((await add(jar, csrf, email)).status).toBe(202);
    expect(h.mail).toHaveLength(5);
  });

  it('refuses at confirmation when the address was taken meanwhile', async () => {
    const { jar, csrf } = await signedIn();
    const email = addr();
    await add(jar, csrf, email);
    await makeUser(f(), { primaryEmail: email });
    const res = await consumeForm(tokenOf(h.mail[0]), jar);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Email in use');
  });

  it('rejects an invalid address', async () => {
    const { jar, csrf } = await signedIn();
    expect((await add(jar, csrf, 'nope')).status).toBe(422);
  });
});
