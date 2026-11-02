import { makeEnv } from '../../../../test/helpers/env.ts';
import { createMockOidc, type MockOidc } from '../../../../test/mock-oidc/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { createSessionStore } from './sessions.ts';

export const ORIGIN = 'https://wallet.plrs.im';
export const ISSUER = 'https://id.test';
export const CLIENT_ID = 'wallet-test';

export interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Rate-limit binding that allows `max` calls per key, then refuses. */
export function fakeLimiter(max: number) {
  const seen = new Map<string, number>();
  return {
    calls: seen,
    async limit({ key }: { key: string }) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= max };
    },
  };
}

export interface TestHarness {
  env: AppEnv;
  mail: SentMail[];
  oidc: MockOidc;
  clock: ManualClock;
  turnstileOk: { value: boolean };
  /** Sends a request through the real app and settles any waitUntil work before returning. */
  call(path: string, init?: RequestInit & { cookies?: Jar; json?: unknown }): Promise<Response>;
  restore(): void;
}

export type Jar = Map<string, string>;

export function jarHeader(jar: Jar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function absorb(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === '';
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
}

export async function harness(
  overrides: Partial<AppEnv> = {},
  options: { clock?: ManualClock; publicClient?: boolean } = {},
): Promise<TestHarness> {
  await resetOidcClientCaches(ISSUER);
  const mail: SentMail[] = [];
  const clock = options.clock ?? new ManualClock(Date.now());
  const oidc = await createMockOidc({
    issuer: ISSUER,
    clientId: overrides.OIDC_CLIENT_ID ?? CLIENT_ID,
    publicClient: options.publicClient,
  });
  const turnstileOk = { value: true };
  const env = await makeEnv({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_ADMIN_GROUP: 'wallet-admins',
    OIDC_USER_GROUP: 'wallet-users',
    EMAIL: {
      send: async (m: { to: string; subject: string; html: string; text: string }) => {
        mail.push({ to: m.to, subject: m.subject, html: m.html, text: m.text });
        return { messageId: `m-${mail.length}` };
      },
    } as unknown as AppEnv['EMAIL'],
    RL_LOGIN: fakeLimiter(1000) as unknown as RateLimit,
    RL_MAGIC_LINK: fakeLimiter(1000) as unknown as RateLimit,
    RL_API_KEY: fakeLimiter(1000) as unknown as RateLimit,
    RL_REFRESH: fakeLimiter(1000) as unknown as RateLimit,
    ...overrides,
  });
  const installed = oidc.install(async (input, init) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/')) {
      const body = new URLSearchParams(String((init as RequestInit | undefined)?.body ?? ''));
      return Response.json({ success: turnstileOk.value && body.get('response') === 'ok' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const app = createApp({
    stores: { sessions: createSessionStore(env, clock), apiKeys: createApiKeyStore(env, clock) },
    clock,
  });

  return {
    env,
    mail,
    oidc,
    clock,
    turnstileOk,
    restore: () => installed.restore(),
    async call(path, init = {}) {
      const { cookies, json, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookies && cookies.size > 0) headers.set('cookie', jarHeader(cookies));
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
        rest.body = JSON.stringify(json);
      }
      if (rest.method && rest.method !== 'GET' && !headers.has('sec-fetch-site')) {
        headers.set('sec-fetch-site', 'same-origin');
      }
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      };
      const res = await app.request(
        `${ORIGIN}${path}`,
        { ...rest, headers },
        env,
        ctx as unknown as ExecutionContext,
      );
      await Promise.allSettled(pending);
      if (cookies) absorb(cookies, res);
      return res;
    },
  };
}
