import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../../test/helpers/index.ts';
import { baseUrl } from '../../platform/env.ts';
import { harness, type Jar, type SentMail, type TestHarness } from './test-support.ts';

let h: TestHarness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

const tokenOf = (m: SentMail | undefined) => /t=([\w-]+)/.exec(m?.text ?? '')?.[1] ?? '';
/** The code on its own line (code first) or after "Code: " (link first). */
const codeOf = (m: SentMail | undefined) =>
  /(?:^|\n|Code: )(\d{6})(?:\n|$)/.exec(m?.text ?? '')?.[1] ?? '';

const request = (email: string, jar: Jar, extra: object = {}) =>
  h.call('/auth/magic/request', {
    method: 'POST',
    json: { email, turnstileToken: 'ok', ...extra },
    cookies: jar,
  });
const known = async () => (await makeUser(fixtures(h.env))).primaryEmail;
const signedIn = async (jar: Jar) =>
  ((await (await h.call('/api/v1/session', { cookies: jar })).json()) as { authenticated: boolean })
    .authenticated;

describe('sign-in email preference', () => {
  it('leads with the link by default', async () => {
    await request(await known(), new Map());
    expect(h.mail[0]?.subject).toBe('Your sign-in link');
    expect(h.mail[0]?.text.startsWith('Sign in to PassBook\n\nSign in: ')).toBe(true);
  });

  it('leads with the code when the installed app asks, and both still sign in', async () => {
    const email = await known();
    const jar: Jar = new Map();
    expect((await request(email, jar, { prefer: 'code' })).status).toBe(202);
    const mail = h.mail[0];
    expect(mail?.subject).toBe('Your sign-in code');
    expect(mail?.text.split('\n\n').slice(0, 2)).toEqual(['Your sign-in code', codeOf(mail)]);
    expect(mail?.text).toContain(`Or open this link: ${baseUrl(h.env)}/auth/magic?t=`);
    const res = await h.call('/auth/magic/consume', {
      method: 'POST',
      json: { email, code: codeOf(mail) },
      cookies: jar,
    });
    expect(res.status).toBe(200);
    expect(await signedIn(jar)).toBe(true);

    // The link in a code-first email grants the same as any other.
    await request(email, new Map(), { prefer: 'code' });
    const linkJar: Jar = new Map();
    const consumed = await h.call('/auth/magic/consume', {
      method: 'POST',
      body: new URLSearchParams({ token: tokenOf(h.mail[1]) }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: linkJar,
    });
    expect(consumed.status).toBe(303);
    expect(await signedIn(linkJar)).toBe(true);
  });

  it('keeps the code bound to the requesting browser', async () => {
    const email = await known();
    await request(email, new Map(), { prefer: 'code' });
    const res = await h.call('/auth/magic/consume', {
      method: 'POST',
      json: { email, code: codeOf(h.mail[0]) },
      cookies: new Map(),
    });
    expect(res.status).toBe(400);
  });

  it('accepts only the known preferences', async () => {
    const email = await known();
    for (const prefer of ['sms', 'CODE', '', 1]) {
      expect((await request(email, new Map(), { prefer })).status).toBe(422);
    }
    expect((await request(email, new Map(), { prefer: 'link' })).status).toBe(202);
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]?.subject).toBe('Your sign-in link');
  });
});
