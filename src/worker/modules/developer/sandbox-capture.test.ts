import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { settle, startAndSettle } from './sandbox-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  // The retry's `operation.run` goes nowhere: the test runs the job's entry itself, on its own clock.
  Object.assign(kit.env, { JOBS: { send: async () => {} } });
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
    const op = await startAndSettle(send, headers, 'POST', '/developer/sandbox', {
      turnstileToken: 'ok',
    });
    expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
    const home = await send('GET', '/developer/home', headers);
    const body = (await home.json()) as { endpoints: { target: string }[] };
    expect(body.endpoints.map((e) => e.target)).toEqual(['capture']);
  });

  it('stops at the capture step when it fails, and a retry finishes the rest', async () => {
    const user = await makeUser(kit.f);
    const { headers } = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    await run(
      kit.env.DB,
      `CREATE TRIGGER qs_block_capture BEFORE INSERT ON webhook_endpoints
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    let failed: OperationDto;
    try {
      failed = await startAndSettle(send, headers, 'POST', '/developer/sandbox', {
        turnstileToken: 'ok',
      });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER qs_block_capture');
    }
    // The exact step is named, and the ones before it stay done.
    expect(failed).toMatchObject({ status: 'failed', step: 'capture', attempt: 1 });
    expect(failed.error).toMatchObject({ step: 'capture', retryable: true });
    expect(failed.steps.map((x) => [x.key, x.state])).toEqual([
      ['org', 'done'],
      ['template', 'done'],
      ['release', 'done'],
      ['capture', 'failed'],
      ['scanner', 'pending'],
    ]);
    const before = await send('GET', '/developer/home', headers);
    const half = (await before.json()) as { state: string; endpoints: unknown[] };
    expect(half.state).toBe('open');
    expect(half.endpoints).toEqual([]);

    const retry = await send('POST', `/operations/${failed.id}/retry`, headers);
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect(((await retry.json()) as { operation: OperationDto }).operation.attempt).toBe(2);
    // The retry is a queued `operation.run`: the job's own entry runs it, as the queue would.
    await handleOperationRun(
      { kind: 'operation.run', operationId: failed.id, attempt: 2 },
      createJobContext(kit.env, 'test', { clock: kit.clock }),
    );
    const done = await settle(send, headers, failed.id);
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(done.steps.every((x) => x.state === 'done')).toBe(true);
    const home = await send('GET', '/developer/home', headers);
    const body = (await home.json()) as { endpoints: { target: string }[]; keys: unknown[] };
    expect(body.endpoints.map((e) => e.target)).toEqual(['capture']);
    // No key was made by any attempt: it is minted once, afterwards.
    expect(body.keys).toHaveLength(0);
  });
});
