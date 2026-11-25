import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from '../../../../test/helpers/env.ts';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';

const ORIGIN = 'https://passbook.mobile';
const app = createApp({ stores: fakeAuth(ORIGIN).stores });

const VALID = {
  name: 'Maya Lin',
  email: 'Maya@Studio.example',
  org: 'Studio <b>Lin</b>',
  purpose: 'Memberships',
  message: 'Line one\r\nLine <script>two</script>',
};

type Sent = { to: string; replyTo?: string; subject: string; html: string; text: string };

async function setup(over: Partial<AppEnv> = {}) {
  const sent: Sent[] = [];
  const env = await makeEnv({
    ACCESS_REQUEST_EMAIL: 'inbox@passbook.example',
    RL_ACCESS: fakeRateLimiter({ limit: 100 }),
    RL_ACCESS_ALL: fakeRateLimiter({ limit: 100 }),
    EMAIL: {
      send: async (m: Sent) => {
        sent.push(m);
        return { messageId: `m-${sent.length}` };
      },
    } as unknown as AppEnv['EMAIL'],
    ...over,
  });
  const post = (
    body: unknown,
    options: { json?: boolean; headers?: Record<string, string> } = {},
  ) =>
    app.request(
      `${ORIGIN}/access`,
      {
        method: 'POST',
        headers: {
          'content-type': options.json ? 'application/json' : 'application/x-www-form-urlencoded',
          origin: ORIGIN,
          ...options.headers,
        },
        body: options.json
          ? JSON.stringify(body)
          : new URLSearchParams(body as Record<string, string>).toString(),
      },
      env,
    );
  return { sent, post, env };
}

const form = (over: Record<string, string> = {}) => ({
  name: VALID.name,
  email: VALID.email,
  org: VALID.org,
  for: VALID.purpose,
  message: VALID.message,
  ...over,
});

/** Every line the Worker wrote to its logs while `act` ran. */
async function logged(act: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  await act();
  for (const spy of spies) spy.mockRestore();
  return lines.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('POST /access', () => {
  it('a form post mails the inbox and redirects 303 to /access/sent', async () => {
    const { sent, post } = await setup();
    const res = await post(form());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/access/sent');
    expect(sent).toHaveLength(1);
    const mail = sent[0] as Sent;
    expect(mail.to).toBe('inbox@passbook.example');
    expect(mail.replyTo).toBe('maya@studio.example');
    expect(mail.subject).toBe('Access request: Studio <b>Lin</b>');
    expect(mail.html).toContain('Studio &lt;b&gt;Lin&lt;/b&gt;');
    expect(mail.html).toContain('Line &lt;script&gt;two&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>two');
    expect(mail.text).toContain('Line one\nLine <script>two</script>');
  });

  it('a JSON post answers 204', async () => {
    const { sent, post } = await setup();
    const res = await post(
      { ...VALID, message: '' },
      { json: true, headers: { accept: 'application/json' } },
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['name', { name: '  ' }],
    ['name', { name: 'x'.repeat(121) }],
    ['email', { email: 'not-an-address' }],
    ['email', { email: 'a@b' }],
    ['org', { org: '' }],
    ['org', { org: 'x'.repeat(161) }],
    ['purpose', { purpose: 'Spam' }],
    ['purpose', { purpose: undefined }],
    ['message', { message: 'x'.repeat(601) }],
  ])('JSON %s invalid answers 422 and sends nothing', async (field, over) => {
    const { sent, post } = await setup();
    const res = await post({ ...VALID, ...over }, { json: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues?: { path: string }[] };
    expect(body.issues?.map((i) => i.path)).toContain(field);
    expect(sent).toHaveLength(0);
  });

  it('a form post with an invalid field gets the HTML error page', async () => {
    const { sent, post } = await setup();
    const res = await post(form({ email: 'nope' }), { headers: { accept: 'text/html' } });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Enter a valid email address.');
    expect(sent).toHaveLength(0);
  });

  it('the select posts as "for"', async () => {
    const { sent, post } = await setup();
    expect((await post(form({ for: 'Something else' }))).status).toBe(303);
    expect(sent[0]?.text).toContain('For: Something else');
  });

  it('a filled honeypot answers success and sends nothing', async () => {
    const { sent, post } = await setup();
    const res = await post(form({ website: 'https://spam.example' }));
    expect(res.status).toBe(303);
    const json = await post({ ...VALID, website: 'x' }, { json: true });
    expect(json.status).toBe(204);
    expect(sent).toHaveLength(0);
  });

  it('429 from the per-network limiter', async () => {
    const { sent, post } = await setup({ RL_ACCESS: fakeRateLimiter({ limit: 1 }) });
    expect((await post(form())).status).toBe(303);
    const res = await post(form(), { headers: { accept: 'text/html' } });
    expect(res.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it('429 from the overall limiter', async () => {
    const { sent, post } = await setup({ RL_ACCESS_ALL: fakeRateLimiter({ limit: 0 }) });
    const res = await post({ ...VALID }, { json: true });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(sent).toHaveLength(0);
  });

  it('a cross-origin post is 403', async () => {
    const { sent, post } = await setup();
    const res = await post(form(), {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses a body over 4 KB and an unknown content type', async () => {
    const { post, env } = await setup();
    expect((await post(form({ message: 'x'.repeat(5000) }))).status).toBe(413);
    const res = await app.request(
      `${ORIGIN}/access`,
      { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'x' },
      env,
    );
    expect(res.status).toBe(415);
  });

  it('a missing EMAIL binding answers 503, never success', async () => {
    const { post } = await setup({ EMAIL: undefined as never });
    const res = await post(VALID, { json: true });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('ACCESS_MAIL_UNAVAILABLE');
    expect((await post(form(), { headers: { accept: 'text/html' } })).status).toBe(503);
  });

  it.each(['', 'nope'])('an invalid recipient %j answers 503', async (to) => {
    const { sent, post } = await setup({ ACCESS_REQUEST_EMAIL: to });
    expect((await post(VALID, { json: true })).status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('a failed send answers 503', async () => {
    const { post } = await setup({
      EMAIL: {
        send: async () => {
          throw new Error('provider echoed Maya Lin');
        },
      } as unknown as AppEnv['EMAIL'],
    });
    expect((await post(VALID, { json: true })).status).toBe(503);
  });

  it('logs codes and purposes, never a submitted value', async () => {
    const { post } = await setup({
      EMAIL: {
        send: async () => {
          throw new Error('provider echoed Maya Lin maya@studio.example');
        },
      } as unknown as AppEnv['EMAIL'],
    });
    const out = await logged(async () => {
      await post(VALID, { json: true });
      await post({ ...VALID, email: 'maya@studio' }, { json: true });
      await post({ ...VALID, website: 'x' }, { json: true });
    });
    expect(out).toContain('marketing.access_failed');
    expect(out).toContain('ACCESS_MAIL_FAILED');
    expect(out).toContain('marketing.access_invalid');
    expect(out).toContain('marketing.access_trap');
    for (const secret of ['Maya', 'maya@', 'studio', 'Studio', 'Line one', 'script', 'echoed']) {
      expect(out).not.toContain(secret);
    }
  });

  it('logs a sent request by purpose only', async () => {
    const { post } = await setup();
    const out = await logged(async () => post(VALID, { json: true }));
    const line = out.split('\n').find((l) => l.includes('marketing.access_sent')) ?? '';
    expect(JSON.parse(line)).toMatchObject({
      code: 'ACCESS_SENT',
      purpose: 'Memberships',
      hasMessage: true,
    });
    expect(out).not.toMatch(/Maya|studio|Line one/i);
  });

  const rawPost = (env: AppEnv, headers: Record<string, string>, body = form()) =>
    app.request(
      `${ORIGIN}/access`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body).toString(),
      },
      env,
    );

  it('refuses a post with no Origin and no Sec-Fetch-Site, and one from same-site', async () => {
    const { sent, env } = await setup();
    expect((await rawPost(env, {})).status).toBe(403);
    expect((await rawPost(env, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await rawPost(env, { 'sec-fetch-site': 'same-origin' })).status).toBe(303);
    expect(sent).toHaveLength(1);
  });

  it('a missing RL_ACCESS binding answers 503', async () => {
    const { sent, post } = await setup({ RL_ACCESS: undefined as never });
    expect((await post(VALID, { json: true })).status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('an oversized declared Content-Length answers 413', async () => {
    const { post } = await setup();
    const res = await post(form(), { headers: { 'content-length': '99999' } });
    expect(res.status).toBe(413);
  });

  it.each(['A\rB', 'A\nB', 'A\u0000B', 'A\u202eB', 'A\u200bB'])(
    'a hidden character in organization or name is refused: %j',
    async (value) => {
      const { sent, post } = await setup();
      expect((await post({ ...VALID, org: value }, { json: true })).status).toBe(422);
      expect((await post({ ...VALID, name: value }, { json: true })).status).toBe(422);
      expect(sent).toHaveLength(0);
    },
  );

  it('a message keeps line breaks and tabs but not invisible marks', async () => {
    const { sent, post } = await setup();
    expect((await post({ ...VALID, message: 'a\n\tb' }, { json: true })).status).toBe(204);
    for (const bad of ['a\u0000b', 'a\u202eb', 'a\u200bb']) {
      expect((await post({ ...VALID, message: bad }, { json: true })).status).toBe(422);
    }
    expect(sent).toHaveLength(1);
  });

  it('ignores a __proto__ key', async () => {
    const { sent, env } = await setup();
    const body = JSON.stringify({ ...VALID, message: '' }).replace(
      '{',
      '{"__proto__":{"purpose":"Spam"},',
    );
    const res = await app.request(
      `${ORIGIN}/access`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body,
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(sent[0]?.text).toContain('For: Memberships');
  });

  it('purpose wins over for', async () => {
    const { sent, post } = await setup();
    await post(form({ purpose: 'Memberships', for: 'Something else' }));
    expect(sent[0]?.text).toContain('For: Memberships');
  });

  it('junk requests do not use the site-wide limit', async () => {
    const all = fakeRateLimiter({ limit: 100 });
    const { post, env } = await setup({ RL_ACCESS_ALL: all });
    await post({ ...VALID, email: 'bad' }, { json: true });
    await post({ ...VALID, website: 'x' }, { json: true });
    await app.request(
      `${ORIGIN}/access`,
      { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'x' },
      env,
    );
    expect(all.counts.size).toBe(0);
    await post(VALID, { json: true });
    expect(all.counts.get('access:all')).toBe(1);
  });

  it('a filled honeypot with a bad email answers 422 like any bad email', async () => {
    const { sent, post } = await setup();
    const res = await post({ ...VALID, email: 'bad', website: 'x' }, { json: true });
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a form post that could not send says so and links back to /access', async () => {
    const { post } = await setup({ ACCESS_REQUEST_EMAIL: '' });
    const res = await post(form(), { headers: { accept: 'text/html' } });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Your request was not sent. Email support@passbook.mobile.');
    expect(html).toContain('href="/access"');
    expect(html).not.toContain('My passes');
    const limited = await setup({ RL_ACCESS: fakeRateLimiter({ limit: 0 }) });
    const res2 = await limited.post(form(), { headers: { accept: 'text/html' } });
    expect(res2.status).toBe(429);
    const html2 = await res2.text();
    expect(html2).toContain('Too many requests. Try again in a minute.');
    expect(html2).toContain('href="/access"');
    expect(res2.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
