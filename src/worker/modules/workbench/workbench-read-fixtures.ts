import { vi } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { makeSandbox } from '../developer/sandbox-test-fixtures.ts';
import { createFakeQueue } from '../passes/pass-test-fixtures.ts';
import { blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { runLane } from '../webhooks/deliver.ts';
import { dispatchLane } from '../webhooks/dispatch.ts';

export const ORIGIN = 'https://wallet.test';
// biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
export type Json = any;

/** A blueprint kit with an app on real session and key stores, a stubbed Turnstile, and helpers for sandboxes. */
export async function workbenchKit() {
  const kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  Object.assign(kit.env, { RL_WEBHOOK_OUT: fakeRateLimiter({ limit: 100_000 }) });
  const app = createApp({
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
  const pending: Promise<unknown>[] = [];
  const ectx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  /** Waits for the request log writes the calls made. */
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  const call = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<[number, Json]> => {
    const res = await app.request(
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
      ectx,
    );
    const text = await res.text();
    return [res.status, text ? JSON.parse(text) : {}];
  };
  /** The app as one person's call: JSON bodies, the idempotency key, a Response back. */
  const send = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Response> | Response =>
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
      ectx,
    );
  /** A developer with a sandbox: the session, the sandbox key, and the quickstart template. */
  async function sandbox(roles: string[] = ['user', 'developer']) {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: roles as never });
    const made = await makeSandbox(send, session.headers);
    if (!made.key || !made.templateId) throw new Error('A new sandbox has a key and a template.');
    return {
      ...made,
      templateId: made.templateId,
      user,
      session,
      key: { authorization: `Bearer ${made.key.secret}` },
    };
  }
  /** Passes made with the given `cf-ray` values, then the capture endpoint's lane run until it is empty. */
  async function eventsFor(s: Awaited<ReturnType<typeof sandbox>>, rays: string[]) {
    const [, cap] = await call('POST', '/webhook-endpoints/capture', s.key, {});
    const endpointId = cap.endpoint.id as string;
    const sample = (await call('GET', `/templates/${s.templateId}`, s.key))[1].manifest.sample;
    const queue = createFakeQueue();
    Object.assign(kit.env, { WEBHOOK_JOBS: queue });
    const passes: string[] = [];
    for (const ray of rays) {
      const [status, pass] = await call(
        'POST',
        '/passes',
        { ...s.key, 'cf-ray': ray },
        { templateId: s.templateId, input: sample ?? {} },
      );
      if (status !== 201) throw new Error(`pass ${status}`);
      passes.push(pass.id);
    }
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    await dispatchLane(ctx, { endpointId, orgId: s.orgId, mode: 'test' });
    while (queue.sent.length > 0) await runLane(ctx, queue.sent.shift() as never);
    return { endpointId, passes };
  }
  return { kit, app, call, settle, sandbox, eventsFor, unstub: () => vi.unstubAllGlobals() };
}
