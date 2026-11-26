import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedDeveloperSandboxSchema } from '../../../shared/contracts/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { sha256Hex } from '../../platform/ids.ts';
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
describe('SANDBOX_TEST_ONLY', () => {
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
      await expectProblem(live, 409, 'SANDBOX_TEST_ONLY');
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

describe('the sandbox key ceiling (scope)', () => {
  it('holds for a key made or rolled in the portal: a a subset passes; key minting, a role bundle beyond it, and rolling an over-ceiling key do not', async () => {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const made = await send('POST', '/developer/sandbox', session.headers, {
      turnstileToken: 'ok',
    });
    const o = CreatedDeveloperSandboxSchema.parse(await made.json()).orgId;
    const h = { ...session.headers, 'x-passbook-mode': 'test' };
    const mint = (extra: Record<string, unknown>) =>
      send('POST', '/api-keys', h, {
        orgId: o,
        name: 'CI',
        kind: 'personal',
        mode: 'test',
        expiresAt: kit.clock.now() + 30 * 86_400_000,
        ...extra,
      });
    const ok = await mint({ scopes: ['passes:read', 'templates:read'] });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const key = (await ok.json()) as { id: string; scopes: string[] };
    const over = await mint({ scopes: ['api-keys:write'] });
    await expectProblem(over, 403, 'API_KEY_SCOPE_EXCEEDS_SANDBOX');
    // Roll keeps the scopes and answers a new secret once.
    const rolled = await send('POST', `/api-keys/${key.id}/rotate`, h, {
      orgId: o,
      overlapHours: 1,
    });
    expect(rolled.status).toBe(201);
    const body = (await rolled.json()) as { key: { scopes: string[]; secret: string } };
    expect(body.key.scopes).toEqual(key.scopes);
    expect(body.key.secret).toMatch(/^pbp_test_/);
  });

  it('refuses a role bundle, an over-ceiling roll and /me/rotate, and the trigger holds beneath the service', async () => {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const made = await send('POST', '/developer/sandbox', session.headers, {
      turnstileToken: 'ok',
    });
    const o = CreatedDeveloperSandboxSchema.parse(await made.json()).orgId;
    const h = { ...session.headers, 'x-passbook-mode': 'test' };
    const role = await send('POST', '/api-keys', h, {
      orgId: o,
      name: 'R',
      kind: 'service',
      mode: 'test',
      roles: ['org_admin'],
    });
    expect(await role.clone().text()).toContain('api-keys:write');
    await expectProblem(role, 403, 'API_KEY_SCOPE_EXCEEDS_SANDBOX');
    const ok = await send('POST', '/api-keys', h, {
      orgId: o,
      name: 'S',
      kind: 'service',
      mode: 'test',
      scopes: ['passes:read'],
    });
    const key = (await ok.json()) as { id: string; secret: string };
    const label = key.secret.slice(0, key.secret.indexOf('_', 5));
    // The trigger refuses a row beyond the ceiling whatever wrote it.
    const row = async (id: string, scopes: string[], prefix = `p${id}`, hash = `h${id}`) =>
      kit.env.DB.prepare(
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, roles, restricted, secret_label)
         SELECT ?, org_id, name, ?, ?, ?, mode, created_at, kind, roles, restricted, secret_label FROM api_keys WHERE id = ?`,
      )
        .bind(id, prefix, hash, JSON.stringify(scopes), key.id)
        .run();
    await expect(row('over-1', ['api-keys:write'])).rejects.toThrow(/sandbox ceiling/);
    // A key that predates the ceiling: lift the trigger to plant one, then it cannot be rolled.
    await kit.env.DB.prepare('DROP TRIGGER api_keys_developer_scope_ceiling').run();
    await row('over-2', ['passes:read', 'api-keys:write']);
    const roll = await send('POST', '/api-keys/over-2/rotate', h, { orgId: o, overlapHours: 1 });
    await expectProblem(roll, 403, 'API_KEY_SCOPE_EXCEEDS_SANDBOX');
    // A key rotating itself is held to the same ceiling.
    const secret = `${label}_selfov12_${'x'.repeat(43)}`;
    await row('over-3', ['passes:read', 'api-keys:write'], 'selfov12', await sha256Hex(secret));
    const me = await send(
      'POST',
      '/api-keys/me/rotate',
      { authorization: `Bearer ${secret}` },
      { overlapHours: 1 },
    );
    await expectProblem(me, 403, 'API_KEY_SCOPE_EXCEEDS_SANDBOX');
  });
});
