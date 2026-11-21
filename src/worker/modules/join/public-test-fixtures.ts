import { vi } from 'vitest';
import type { TestTemplate } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { absorb, fakeLimiter, type Jar, jarHeader } from '../auth/test-support.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { joinTemplate } from './join-test-fixtures.ts';

export const BASE = 'https://passbook.mobile';
const HOST = new URL(BASE).hostname;

/** siteverify's answer for a good token; `over` changes it. */
export const verdictOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  success: true,
  hostname: HOST,
  action: 'join',
  ...over,
});
export { absorb, type Jar };

/** What Cloudflare's siteverify answers in these tests, and the tokens it was asked about. */
export const turnstile = {
  verdict: verdictOf(),
  asked: [] as string[],
};

export type Link = Awaited<ReturnType<typeof makeJoinLink>>;

export interface PublicKit<K extends Kit = Kit> {
  kit: K;
  app: ReturnType<typeof createApp>;
  /** A link of the kit's org on the kit's template; replaces the one an earlier test left. */
  link(options?: {
    mode?: 'live' | 'test';
    dailyLimit?: number;
    askEmail?: boolean;
    enabled?: boolean;
  }): Promise<Link>;
  /** A form post. `fields` override the defaults; a field set to null is left out. */
  post(
    l: Link,
    fields?: Record<string, string | null>,
    options?: {
      jar?: Jar;
      ip?: string;
      env?: AppEnv;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response>;
  get(l: Link, options?: { env?: AppEnv; ip?: string }): Promise<Response>;
  restore(): void;
}

/** A kit with a join-ready template, Turnstile stubbed and the join rate limits wide open. */
export async function publicKit<K extends Kit = Kit>(
  template: (id: string) => TestTemplate = (id) => joinTemplate(id),
  setup: (options: Parameters<typeof setupKit>[0]) => Promise<K> = setupKit as never,
): Promise<PublicKit<K>> {
  const kit = await setup({
    template,
    env: {
      // Not the always-pass secret: the hostname and action checks run.
      TURNSTILE_SECRET: 'test-secret',
      RL_JOIN: fakeLimiter(1000) as unknown as RateLimit,
      RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit,
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://challenges.cloudflare.com/'))
      throw new Error(`Unmocked network call in test: ${url}`);
    turnstile.asked.push(new URLSearchParams(String(init?.body ?? '')).get('response') ?? '');
    return Response.json(turnstile.verdict);
  }) as typeof fetch;
  const app = createApp({ clock: kit.clock });
  return {
    kit,
    app,
    async link(options = {}) {
      const mode = options.mode ?? 'live';
      await run(
        kit.env.DB,
        'DELETE FROM join_links WHERE org_id = ? AND mode = ? AND template_id = ?',
        [kit.org.id, mode, kit.template.id],
      );
      const made = await makeJoinLink(kit.fx, {
        orgId: kit.org.id,
        templateId: kit.template.id,
        mode,
        ...(options.dailyLimit ? { dailyLimit: options.dailyLimit } : {}),
        ...(options.enabled === false ? { enabled: false } : {}),
      });
      await run(kit.env.DB, 'UPDATE join_links SET ask_email = ?, name_input = ? WHERE id = ?', [
        options.askEmail === false ? 0 : 1,
        'memberName',
        made.id,
      ]);
      return made;
    },
    post(l, fields = {}, options = {}) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries({
        name: 'Sam',
        'cf-turnstile-response': 'tok',
        ...fields,
      }))
        if (v !== null) form.set(k, v);
      const jar = options.jar ?? new Map();
      // The mail work runs after the response; the test waits for it, as a Worker's isolate does.
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      return Promise.resolve(
        app.request(
          `${BASE}/j/${l.token}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              origin: BASE,
              'cf-connecting-ip': options.ip ?? '203.0.113.5',
              ...(jar.size > 0 ? { cookie: jarHeader(jar) } : {}),
              ...options.headers,
            },
            body: options.body ?? form.toString(),
          },
          options.env ?? kit.env,
          ctx,
        ),
      ).then(async (res) => {
        await Promise.all(pending);
        absorb(jar, res);
        return res;
      });
    },
    get(l, options = {}) {
      return Promise.resolve(
        app.request(
          `${BASE}/j/${l.token}`,
          { headers: { 'cf-connecting-ip': options.ip ?? '203.0.113.5' } },
          options.env ?? kit.env,
        ),
      );
    },
    restore() {
      globalThis.fetch = original;
      vi.restoreAllMocks();
      turnstile.verdict = verdictOf();
      turnstile.asked.length = 0;
    },
  };
}
