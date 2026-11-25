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
});
