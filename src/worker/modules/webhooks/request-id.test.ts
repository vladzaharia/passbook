import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { makeSandbox } from '../developer/sandbox-test-fixtures.ts';
import { createFakeQueue } from '../passes/pass-test-fixtures.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { runLane } from './deliver.ts';
import { dispatchLane } from './dispatch.ts';

const ORIGIN = 'https://wallet.test';
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;

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
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input, init).url.startsWith('https://challenges.cloudflare.com/')
      ? Response.json({ success: true })
      : real(input, init),
  );
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  Object.assign(kit.env, { RL_WEBHOOK_OUT: fakeRateLimiter({ limit: 100_000 }) });
});

type Json = any;
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const call = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<[number, Json]> => {
  const res = await send(method, path, headers, body);
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}];
};

async function sandbox() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  const made = await makeSandbox(send, session.headers);
  return { ...made, session, key: { authorization: `Bearer ${made.key?.secret}` } };
}

describe('sandbox time zone', () => {
  it("is the org's zone, America/Los_Angeles when it has none", async () => {
    const s = await sandbox();
    const read = async () =>
      (await call('GET', '/developer/sandbox', s.session.headers))[1].sandbox;
    expect((await read()).timeZone).toBe('America/Los_Angeles');
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', '\"Europe/Berlin\"', 1)",
      [`org:${s.orgId}`],
    );
    expect((await read()).timeZone).toBe('Europe/Berlin');
  });
});

describe('request id on events', () => {
  it('rides the event and filters the feed, captures and deliveries', async () => {
    const s = await sandbox();
    const [, cap] = await call('POST', '/webhook-endpoints/capture', s.key, {});
    const id = cap.endpoint.id as string;
    const sample = (await call('GET', `/templates/${s.templateId}`, s.key))[1].manifest.sample;
    const queue = createFakeQueue();
    Object.assign(kit.env, { WEBHOOK_JOBS: queue });
    const make = async (ray: string) => {
      const [status, pass] = await call(
        'POST',
        '/passes',
        { ...s.key, 'cf-ray': ray },
        { templateId: s.templateId, input: sample ?? {} },
      );
      expect(status).toBe(201);
      return pass.id as string;
    };
    const a = await make('ray-a-SEA');
    const b = await make('ray-b-SEA');
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    await dispatchLane(ctx, { endpointId: id, orgId: s.orgId, mode: 'test' });
    while (queue.sent.length > 0) await runLane(ctx, queue.sent.shift() as never);

    const feed = (await call('GET', '/events', s.key))[1];
    const issuedA = feed.items.find((e: Json) => e.pass?.id === a && e.type === 'pass.issued');
    expect(issuedA.requestId).toBe('ray-a-SEA');
    expect(JSON.stringify(issuedA.data)).not.toContain('ray-a');

    const ids = (page: Json) => page.items.map((i: Json) => i.eventId);
    const all = (await call('GET', `/webhook-endpoints/${id}/captures`, s.key))[1];
    const byRay = (
      await call('GET', `/webhook-endpoints/${id}/captures?requestId=ray-a-SEA`, s.key)
    )[1];
    expect(byRay.items.length).toBeGreaterThan(0);
    expect(byRay.items.length).toBeLessThan(all.items.length);
    expect(ids(byRay)).toContain(issuedA.id);
    const byPass = (await call('GET', `/webhook-endpoints/${id}/captures?passId=${b}`, s.key))[1];
    expect(ids(byPass)).not.toContain(issuedA.id);
    expect(byPass.items.length).toBeGreaterThan(0);
    const none = (
      await call('GET', `/webhook-endpoints/${id}/captures?requestId=ray-a-SEA&passId=${b}`, s.key)
    )[1];
    expect(none.items).toEqual([]);

    const dRay = (
      await call('GET', `/webhook-endpoints/${id}/deliveries?requestId=ray-b-SEA`, s.key)
    )[1];
    expect(dRay.items.length).toBeGreaterThan(0);
    expect(dRay.items.every((i: Json) => i.passId === b)).toBe(true);
    const dPass = (await call('GET', `/webhook-endpoints/${id}/deliveries?passId=${a}`, s.key))[1];
    expect(dPass.items.every((i: Json) => i.passId === a)).toBe(true);
    expect(dPass.items.length).toBeGreaterThan(0);
    const dNone = (
      await call('GET', `/webhook-endpoints/${id}/deliveries?requestId=nope`, s.key)
    )[1];
    expect(dNone.items).toEqual([]);
  });
});
