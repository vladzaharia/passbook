import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { fakeLimiter, harness, type Jar, type SentMail, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const addr = () => `pg${++n}${Math.random().toString(36).slice(2, 8)}@example.test`;
const tokenOf = (m: SentMail | undefined) => /t=([\w-]+)/.exec(m?.text ?? '')?.[1] ?? '';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const HTML = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

const requestLink = (email: string, jar: Jar = new Map(), extra: object = {}) =>
  h.call('/auth/magic/request', {
    method: 'POST',
    json: { email, turnstileToken: 'ok', ...extra },
    cookies: jar,
  });
const consumeForm = (fields: Record<string, string>, jar: Jar = new Map()) =>
  h.call('/auth/magic/consume', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { ...FORM, ...HTML },
    cookies: jar,
  });
const page = (path: string, jar: Jar = new Map()) => h.call(path, { headers: HTML, cookies: jar });
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
const loginNext = (next: string) => `/login?next=${encodeURIComponent(next)}`;

async function setMagic(on: boolean) {
  await run(h.env.DB, "DELETE FROM settings WHERE key = 'auth.magicLinkEnabled'");
  if (!on)
    await run(
      h.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.magicLinkEnabled', 'false', 0)",
    );
  clearSettingsCache(h.env.DB);
}

async function signedIn() {
  const email = (await makeUser(fixtures(h.env))).primaryEmail;
  const jar: Jar = new Map();
  await requestLink(email, jar);
  await consumeForm({ token: tokenOf(h.mail.at(-1)) }, jar);
  const s = (await (await h.call('/api/v1/session', { cookies: jar })).json()) as {
    csrfToken: string;
    user: { primaryEmail: string };
  };
  return { jar, csrf: s.csrfToken, email: s.user.primaryEmail };
}

async function verifyLink(requester: Awaited<ReturnType<typeof signedIn>>, email = addr()) {
  const before = h.mail.length;
  await h.call('/api/v1/me/emails', {
    method: 'POST',
    json: { email },
    cookies: requester.jar,
    headers: { 'x-csrf-token': requester.csrf },
  });
  expect(h.mail.length).toBe(before + 1);
  return { email, token: tokenOf(h.mail.at(-1)) };
}

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await setMagic(true);
  h.restore();
});

describe('form posts get pages, never problem+json', () => {
  it('a malformed body', async () => {
    const res = await consumeForm({ token: 'short' });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Sign-in failed<\/h1>/);
    expect(hrefs(html)).toContain('/login');
  });

  it('a rate limit, keeping Retry-After', async () => {
    h.restore();
    h = await harness({ RL_LOGIN: fakeLimiter(0) as unknown as RateLimit });
    const res = await consumeForm({ token: 'x'.repeat(43) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.text()).toMatch(/<h1[^>]*>Too many requests<\/h1>/);
  });

  it('email sign-in turned off after the link was sent', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email, new Map(), { next: '/passes/7' });
    const token = tokenOf(h.mail[0]);
    await setMagic(false);
    const res = await consumeForm({ token });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Email sign-in is off<\/h1>/);
    expect(hrefs(html)).toContain(loginNext('/passes/7'));
  });
});

describe('confirm page', () => {
  it('does not offer Sign in while email sign-in is off', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email);
    await setMagic(false);
    const res = await page(`/auth/magic?t=${tokenOf(h.mail[0])}`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Email sign-in is off<\/h1>/);
    expect(html).not.toContain('action="/auth/magic/consume"');
  });

  it('keeps next on the expired page of a used link', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email, new Map(), { next: '/passes/9' });
    const token = tokenOf(h.mail[0]);
    expect((await consumeForm({ token })).status).toBe(303);
    for (const res of [await page(`/auth/magic?t=${token}`), await consumeForm({ token })]) {
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toMatch(/<h1[^>]*>Link expired<\/h1>/);
      expect(hrefs(html)).toContain(loginNext('/passes/9'));
    }
    const unknown = await (await page(`/auth/magic?t=${'u'.repeat(43)}`)).text();
    expect(hrefs(unknown)).toContain('/login');
  });
});

describe('add-email verification', () => {
  it('offers Confirm to the account that asked, then lands on /account?verified=', async () => {
    const me = await signedIn();
    const { email, token } = await verifyLink(me);
    const html = await (await page(`/auth/magic?t=${token}`, me.jar)).text();
    expect(html).toContain('action="/auth/magic/consume"');
    expect(html).toMatch(/<button[^>]*>Confirm<\/button>/);
    const res = await consumeForm({ token }, me.jar);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/account?verified=${encodeURIComponent(email)}`);
    expect(
      await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [email]),
    ).not.toBeNull();
  });

  it('answers the code JSON with the same landing', async () => {
    const me = await signedIn();
    const { email, token } = await verifyLink(me);
    const res = await h.call('/auth/magic/consume', {
      method: 'POST',
      json: { token },
      cookies: me.jar,
    });
    expect(await res.json()).toEqual({
      ok: true,
      next: `/account?verified=${encodeURIComponent(email)}`,
    });
  });

  it('sends a signed-out browser to sign in and back, consuming nothing', async () => {
    const me = await signedIn();
    const { email, token } = await verifyLink(me);
    const res = await page(`/auth/magic?t=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('action="/auth/magic/consume"');
    expect(html).toContain(me.email);
    const back = loginNext(`/auth/magic?t=${token}`);
    expect(hrefs(html)).toContain(back);
    expect(html).toMatch(/>Sign in to confirm</);
    expect(await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [email])).toBeNull();
  });

  it('offers another signed-in account a switch that carries the link', async () => {
    const me = await signedIn();
    const other = await signedIn();
    const { token } = await verifyLink(me);
    const html = await (await page(`/auth/magic?t=${token}`, other.jar)).text();
    expect(html).not.toContain('action="/auth/magic/consume"');
    const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(action).toBe(`/auth/logout?next=${encodeURIComponent(`/auth/magic?t=${token}`)}`);
    // The switch signs this browser out and returns to sign-in with the link as next.
    const out = await h.call(action.replaceAll('&amp;', '&'), {
      method: 'POST',
      cookies: other.jar,
      headers: { ...FORM, ...HTML },
    });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe(loginNext(`/auth/magic?t=${token}`));
  });

  it('a Confirm posted without the session gets a way to sign in, not a dead end', async () => {
    const me = await signedIn();
    const { token } = await verifyLink(me);
    const res = await consumeForm({ token });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Sign in first<\/h1>/);
    expect(hrefs(html)).toContain(loginNext(`/auth/magic?t=${token}`));
  });
});
