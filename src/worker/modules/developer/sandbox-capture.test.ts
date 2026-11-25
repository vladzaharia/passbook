import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

describe('a new sandbox', () => {
  it('has its capture endpoint', async () => {
    const user = await makeUser(kit.f);
    const { headers } = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const res = await send('POST', '/developer/sandbox', headers, { turnstileToken: 'ok' });
    const text = await res.clone().text();
    expect(res.status, text).toBe(201);
    const home = await send('GET', '/developer/home', headers);
    const body = (await home.json()) as { endpoints: { target: string }[] };
    expect(body.endpoints.map((e) => e.target)).toEqual(['capture']);
  });

  it('gets the capture endpoint on a retry after the first attempt failed at it', async () => {
    const user = await makeUser(kit.f);
    const { headers } = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    await run(
      kit.env.DB,
      `CREATE TRIGGER qs_block_capture BEFORE INSERT ON webhook_endpoints
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    let first: Response;
    try {
      first = await send('POST', '/developer/sandbox', headers, { turnstileToken: 'ok' });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER qs_block_capture');
    }
    expect(first.status).toBeGreaterThanOrEqual(400);
    const before = await send('GET', '/developer/home', headers);
    const half = (await before.json()) as { state: string; endpoints: unknown[] };
    expect(half.state).toBe('open');
    expect(half.endpoints).toEqual([]);

    const retry = await send('POST', '/developer/sandbox', headers, { turnstileToken: 'ok' });
    expect(retry.status, await retry.clone().text()).toBe(201);
    const home = await send('GET', '/developer/home', headers);
    const body = (await home.json()) as { endpoints: { target: string }[]; keys: unknown[] };
    expect(body.endpoints.map((e) => e.target)).toEqual(['capture']);
    expect(body.keys).toHaveLength(1);
  });
});
