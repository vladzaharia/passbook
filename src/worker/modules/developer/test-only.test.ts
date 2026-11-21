import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedDeveloperSandboxSchema } from '../../../shared/contracts/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
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
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
describe('ORG_TEST_ONLY', () => {
  it('refuses Live on a developer org in every console router family, and allows Test', async () => {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const res = await send('POST', '/developer/sandbox', session.headers, { turnstileToken: 'ok' });
    const o = CreatedDeveloperSandboxSchema.parse(await res.json()).orgId;
    const families: [string, string, string, unknown?][] = [
      ['templates', 'GET', `/templates?orgId=${o}`],
      ['connections', 'GET', `/connections?orgId=${o}`],
      ['api-keys', 'GET', `/api-keys?orgId=${o}`],
      ['orgs', 'PATCH', `/orgs/${o}`, { name: 'Renamed' }],
      ['broadcasts', 'GET', `/broadcasts?orgId=${o}`],
      ['bundles', 'GET', `/bundles?orgId=${o}`],
      ['identities', 'GET', `/identities?orgId=${o}`],
      ['holders', 'GET', `/holders?orgId=${o}`],
      ['message-rules', 'GET', `/message-rules?orgId=${o}`],
      ['nfc', 'GET', `/nfc/keysets?orgId=${o}`],
      ['workspace', 'GET', `/orgs/${o}/workspace`],
    ];
    for (const [family, method, path, body] of families) {
      const live = await send(method, path, session.headers, body);
      await expectProblem(live, 409, 'ORG_TEST_ONLY');
      expect(live.status, family).toBe(409);
      const test = await send(
        method,
        path,
        { ...session.headers, 'x-passbook-mode': 'test' },
        body,
      );
      expect(test.status, `${family} in Test`).toBeLessThan(400);
    }
  });
});
