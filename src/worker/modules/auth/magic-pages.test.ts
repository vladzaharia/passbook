import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
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
      expect(html).toMatch(/<h1[^>]*>Link already used<\/h1>/);
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

describe('dead links', () => {
  it('words used and expired apart, each with a resend to the masked address', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email);
    const used = tokenOf(h.mail[0]);
    await consumeForm({ token: used });
    await requestLink(email);
    const stale = tokenOf(h.mail[1]);
    h.clock.advance(16 * 60_000);
    const usedHtml = await (await page(`/auth/magic?t=${used}`)).text();
    const staleHtml = await (await page(`/auth/magic?t=${stale}`)).text();
    expect(usedHtml).toMatch(/<h1[^>]*>Link already used<\/h1>/);
    expect(usedHtml).toContain('Open PassBook');
    expect(staleHtml).toMatch(/<h1[^>]*>Link expired<\/h1>/);
    expect(staleHtml).not.toContain('Open PassBook');
    for (const html of [usedHtml, staleHtml]) {
      expect(html).toContain('action="/auth/magic/resend"');
      expect(html).toContain('Email me a new link');
      expect(html).not.toContain(email);
    }
  });

  it('resend mails the link address a new link and answers the same for a stranger', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email);
    const token = tokenOf(h.mail[0]);
    h.clock.advance(16 * 60_000);
    const before = h.mail.length;
    const res = await h.call('/auth/magic/resend', {
      method: 'POST',
      body: new URLSearchParams({ token }),
      headers: { ...FORM, ...HTML },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Check your email<\/h1>/);
    expect(h.mail.length).toBe(before + 1);
    expect(h.mail.at(-1)?.to).toBe(email);
    const stranger = await h.call('/auth/magic/resend', {
      method: 'POST',
      body: new URLSearchParams({ token: 'z'.repeat(43) }),
      headers: { ...FORM, ...HTML },
    });
    const plain = (x: string) => x.replace(/nonce="[^"]*"/g, '');
    expect(plain(await stranger.text())).toBe(plain(html));
    expect(h.mail.length).toBe(before + 1);
  });

  it('an invitation link names the org and role, and is not offered a resend', async () => {
    const org = await makeOrg(fixtures(h.env));
    const email = addr();
    const now = h.clock.now();
    await run(
      h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES ('inv-pg', ?, ?, '["org_admin"]', ?, ?, ?)`,
      [org.id, email, await sha256Hex('inv'), now, now + 86_400_000],
    );
    const token = 'i'.repeat(43);
    await run(
      h.env.DB,
      `INSERT INTO magic_links (token_hash, email, purpose, redirect_path, invitation_id, created_at, expires_at)
       VALUES (?, ?, 'sign_in', '/account', 'inv-pg', ?, ?)`,
      [await sha256Hex(token), email, now, now + 86_400_000],
    );
    const html = await (await page(`/auth/magic?t=${token}`)).text();
    expect(html).toContain(`Join ${org.name}`);
    expect(html).toContain('an organization admin');
    expect(html).toContain('Accept and sign in');
    expect(html).not.toContain('tied to your email');
    // Expired normally (after it was made); `expires_at <= created_at` reads as voided by 0169.
    await run(
      h.env.DB,
      "UPDATE magic_links SET created_at = ?, expires_at = ? WHERE invitation_id = 'inv-pg'",
      [now - 2_000, now - 1_000],
    );
    const dead = await (await page(`/auth/magic?t=${token}`)).text();
    expect(dead).toMatch(/<h1[^>]*>Invitation expired<\/h1>/);
    expect(dead).not.toContain('/auth/magic/resend');
  });

  async function invitedLink(token: string, email: string, id: string) {
    const org = await makeOrg(fixtures(h.env));
    const now = h.clock.now();
    await run(
      h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, '["org_admin"]', ?, ?, ?)`,
      [id, org.id, email, await sha256Hex(`h${id}`), now, now + 86_400_000],
    );
    await run(
      h.env.DB,
      `INSERT INTO magic_links (token_hash, email, purpose, redirect_path, invitation_id, created_at, expires_at)
       VALUES (?, ?, 'sign_in', '/account', ?, ?, ?)`,
      [await sha256Hex(token), email, id, now, now + 86_400_000],
    );
  }

  it('an invitation whose address already has an account is pending, not expired', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    const token = 'p'.repeat(43);
    await invitedLink(token, email, 'inv-pend');
    const html = await (await page(`/auth/magic?t=${token}`)).text();
    expect(html).toMatch(/<h1[^>]*>Invitation pending<\/h1>/);
    expect(html).toContain('Sign in with this address to accept.');
    expect(hrefs(html)).toContain('/login?next=%2Faccount');
    expect(html).not.toContain('/auth/magic/resend');
  });

  it('an accepted invitation says used; a revoked one says expired', async () => {
    const token = 'a'.repeat(43);
    await invitedLink(token, addr(), 'inv-acc');
    await run(h.env.DB, "UPDATE org_invitations SET accepted_at = 1 WHERE id = 'inv-acc'");
    const accepted = await (await page(`/auth/magic?t=${token}`)).text();
    expect(accepted).toMatch(/<h1[^>]*>Invitation already used<\/h1>/);
    expect(accepted).toContain('Open PassBook');
    const other = 'r'.repeat(43);
    await invitedLink(other, addr(), 'inv-rev');
    await run(h.env.DB, "UPDATE org_invitations SET revoked_at = 1 WHERE id = 'inv-rev'");
    const revoked = await (await page(`/auth/magic?t=${other}`)).text();
    expect(revoked).toMatch(/<h1[^>]*>Invitation expired<\/h1>/);
    expect(revoked).not.toContain('Open PassBook');
  });
});

describe('resend refusals send no mail', () => {
  const resend = (token: string, headers: Record<string, string> = {}) =>
    h.call('/auth/magic/resend', {
      method: 'POST',
      body: new URLSearchParams({ token }),
      headers: { ...FORM, ...HTML, ...headers },
    });

  it('an invitation link', async () => {
    const org = await makeOrg(fixtures(h.env));
    const email = addr();
    const now = h.clock.now();
    await run(
      h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES ('inv-rs', ?, ?, '["org_admin"]', ?, ?, ?)`,
      [org.id, email, await sha256Hex('inv-rs'), now, now + 86_400_000],
    );
    const token = 'q'.repeat(43);
    await run(
      h.env.DB,
      `INSERT INTO magic_links (token_hash, email, purpose, invitation_id, created_at, expires_at)
       VALUES (?, ?, 'sign_in', 'inv-rs', ?, ?)`,
      [await sha256Hex(token), email, now, now + 86_400_000],
    );
    const before = h.mail.length;
    expect((await resend(token)).status).toBe(200);
    expect(h.mail.length).toBe(before);
  });

  it('an add-email link', async () => {
    const me = await signedIn();
    const { token } = await verifyLink(me);
    const before = h.mail.length;
    expect((await resend(token)).status).toBe(200);
    expect(h.mail.length).toBe(before);
  });

  it('email sign-in off', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email);
    const token = tokenOf(h.mail.at(-1));
    await setMagic(false);
    h.clock.advance(16 * 60_000);
    expect(await (await page(`/auth/magic?t=${token}`)).text()).not.toContain('/auth/magic/resend');
    const before = h.mail.length;
    expect((await resend(token)).status).toBe(200);
    expect(h.mail.length).toBe(before);
  });

  it('a cross-origin POST', async () => {
    const email = (await makeUser(fixtures(h.env))).primaryEmail;
    await requestLink(email);
    const token = tokenOf(h.mail.at(-1));
    const before = h.mail.length;
    expect(
      (await resend(token, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(403);
    expect(h.mail.length).toBe(before);
  });
});
