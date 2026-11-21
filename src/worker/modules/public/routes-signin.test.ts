import { beforeAll, describe, expect, it } from 'vitest';
import { linkToken } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import { voidPass } from '../passes/service.ts';

const ORIGIN = 'https://wallet.test';
const actor = { type: 'user', id: 'admin-1' } as const;
const HOLDER = 'holder@example.test';
let kit: Kit;
let mail: { to: string; subject: string; text: string }[];

beforeAll(async () => {
  kit = await setupKit();
});

function setup(over: Record<string, unknown> = {}) {
  mail = [];
  const env = {
    ...kit.env,
    RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit,
    RL_REFRESH: fakeLimiter(1000) as unknown as RateLimit,
    RL_MAGIC_LINK: fakeLimiter(1000) as unknown as RateLimit,
    EMAIL: {
      send: async (m: { to: string; subject: string; text: string }) => {
        mail.push({ to: m.to, subject: m.subject, text: m.text });
        return { messageId: `m-${mail.length}` };
      },
    } as unknown as typeof kit.env.EMAIL,
    ...over,
  };
  const app = createApp({
    stores: {
      sessions: createSessionStore(env, kit.clock),
      apiKeys: createApiKeyStore(env, kit.clock),
      scanners: denyAllStores.scanners,
    },
    clock: kit.clock,
  });
  const post = async (path: string, headers: Record<string, string> = {}) => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException() {},
    };
    const res = await app.request(
      `${ORIGIN}${path}`,
      { method: 'POST', headers: { origin: ORIGIN, ...headers } },
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);
    return res;
  };
  return { env, app, post };
}

const tokenIn = (text: string) => /t=([\w-]+)/.exec(text)?.[1] ?? '';

describe('POST /p/:token/sign-in', () => {
  it('mails a sign-in link to the holder and never shows the address', async () => {
    const { post } = setup();
    const pass = await kit.pass({ holderEmail: HOLDER });
    const token = await linkToken(kit.env, pass);
    const res = await post(`/p/${token}/sign-in`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/p/${token}?signin=sent`);
    expect(await res.text()).not.toContain(HOLDER);
    expect([...res.headers].join('\n')).not.toContain(HOLDER);
    expect(mail.map((m) => m.to)).toEqual([HOLDER]);
    expect(mail[0]?.text).toContain('/auth/magic?t=');
  });

  it('answers the same, and sends nothing, for an unknown token or a pass without an email', async () => {
    const { post } = setup();
    const bare = await kit.pass();
    for (const token of ['A'.repeat(43), await linkToken(kit.env, bare)]) {
      const res = await post(`/p/${token}/sign-in`);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/p/${token}?signin=sent`);
    }
    expect(mail).toEqual([]);
  });

  it('refuses a malformed token and a cross-origin post', async () => {
    const { post } = setup();
    const pass = await kit.pass({ holderEmail: HOLDER });
    const token = await linkToken(kit.env, pass);
    for (const bad of ['short', 'abc%0d%0aSet-Cookie:x']) {
      const res = await post(`/p/${bad}/sign-in`);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
    expect((await post(`/p/${token}/sign-in`, { origin: 'https://evil.test' })).status).toBe(403);
    expect(mail).toEqual([]);
  });

  it('works for a voided and a removed pass', async () => {
    const { post } = setup();
    const voided = await kit.pass({ holderEmail: HOLDER });
    await voidPass(jobCtxOf(kit), actor, voided.id, null);
    const removed = await kit.pass({ holderEmail: HOLDER });
    await removePass(jobCtxOf(kit), actor, removed.id, {}, null);
    for (const pass of [voided, removed]) {
      const token = await linkToken(kit.env, pass);
      const res = await post(`/p/${token}/sign-in`);
      expect(res.headers.get('location')).toBe(`/p/${token}?signin=sent`);
    }
    expect(mail).toHaveLength(2);
  });

  it('is gated like resend: RL_PUBLIC refuses, and the hourly per-pass cap answers wait', async () => {
    const pass = await kit.pass({ holderEmail: HOLDER });
    const token = await linkToken(kit.env, pass);
    const open = setup({ RL_PUBLIC: fakeLimiter(0) as unknown as RateLimit });
    expect((await open.post(`/p/${token}/sign-in`)).status).toBe(429);
    expect(mail).toEqual([]);
    const capped = setup({ RL_REFRESH: fakeLimiter(1) as unknown as RateLimit });
    expect((await capped.post(`/p/${token}/sign-in`)).headers.get('location')).toBe(
      `/p/${token}?signin=sent`,
    );
    const again = await capped.post(`/p/${token}/sign-in`);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`/p/${token}?signin=wait`);
    expect(mail).toHaveLength(1);
  });

  it('audits the request without the address, and the link opens a holder session only', async () => {
    const { post, app, env } = setup();
    const pass = await kit.pass({ holderEmail: HOLDER });
    const token = await linkToken(kit.env, pass);
    const res = await post(`/p/${token}/sign-in`);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const rows = await all<{ action: string; detail: string | null; target_id: string }>(
      kit.env.DB,
      `SELECT action, detail, target_id FROM audit_log WHERE action = 'holder.sign_in_requested' AND target_id = ?`,
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(HOLDER);
    expect(JSON.stringify(rows)).not.toContain(token);

    const consume = await app.request(
      `${ORIGIN}/auth/magic/consume`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: new URLSearchParams({ token: tokenIn(mail[0]?.text ?? '') }),
      },
      env,
    );
    expect(consume.status).toBe(303);
    const session = await app.request(
      `${ORIGIN}/api/v1/session`,
      {
        headers: {
          cookie: consume.headers
            .getSetCookie()
            .map((c) => c.split(';')[0])
            .join('; '),
        },
      },
      env,
    );
    const body = (await session.json()) as { authenticated: boolean; roles: string[] };
    expect(body.authenticated).toBe(true);
    expect(body.roles).toEqual(['user']);
  });
});
