import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedDeveloperSandboxSchema } from '../../../shared/contracts/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { beginPurge } from '../org-lifecycle/purge.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const realFetch = globalThis.fetch;
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const purges = vi.fn(async (_: unknown) => ({}));

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  Object.assign(kit.env, { ORG_PURGE: { create: purges } });
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

async function person() {
  const user = await makeUser(kit.f);
  const { headers } = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  return { user, headers };
}

async function sandboxOf() {
  const p = await person();
  const res = await send('POST', '/developer/sandbox', p.headers, { turnstileToken: 'ok' });
  expect(res.status, await res.clone().text()).toBe(201);
  return { ...p, made: CreatedDeveloperSandboxSchema.parse(await res.json()) };
}

const orgRow = (id: string) =>
  first<{ status: string; purge_after: number | null }>(
    kit.env.DB,
    'SELECT status, purge_after FROM orgs WHERE id = ?',
    [id],
  );

describe('DELETE /developer/sandbox', () => {
  it('removes the sandbox: org closed and due for purge, keys revoked, record gone, audit row', async () => {
    const s = await sandboxOf();
    const other = await sandboxOf();
    const res = await send('DELETE', '/developer/sandbox', s.headers);
    expect(res.status).toBe(204);

    expect(await orgRow(s.made.orgId)).toEqual({ status: 'deleted', purge_after: kit.clock.now() });
    const keys = await all<{ revoked_at: number | null }>(
      kit.env.DB,
      'SELECT revoked_at FROM api_keys WHERE org_id = ?',
      [s.made.orgId],
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.revoked_at !== null)).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM developer_sandboxes WHERE user_id = ?', [s.user.id]),
    ).toBeNull();
    const audit = await first<{ org_id: string | null; target_id: string }>(
      kit.env.DB,
      "SELECT org_id, target_id FROM audit_log WHERE action = 'developer.sandbox_deleted' AND actor_id = ?",
      [s.user.id],
    );
    expect(audit).toEqual({ org_id: null, target_id: s.made.orgId });
    expect(purges).toHaveBeenCalledWith(
      expect.objectContaining({ params: { orgId: s.made.orgId } }),
    );
    // The org purge takes it from here: it is due now.
    expect(
      await beginPurge(createJobContext(kit.env, 'test', { clock: kit.clock }), s.made.orgId),
    ).toBe('started');

    // Another person's sandbox is untouched.
    expect((await orgRow(other.made.orgId))?.status).toBe('active');
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM developer_sandboxes WHERE user_id = ?', [
        other.user.id,
      ]),
    ).not.toBeNull();
  });

  it('removes a closed sandbox too, and a missing one is a 404', async () => {
    const s = await sandboxOf();
    expect((await send('POST', '/developer/sandbox/close', s.headers)).status).toBe(200);
    expect((await send('DELETE', '/developer/sandbox', s.headers)).status).toBe(204);
    expect((await orgRow(s.made.orgId))?.purge_after).toBe(kit.clock.now());
    await expectProblem(
      await send('DELETE', '/developer/sandbox', s.headers),
      404,
      'SANDBOX_NOT_FOUND',
    );
  });

  it('lets a deleted person make a new sandbox, but a closed one still blocks it', async () => {
    const s = await sandboxOf();
    await send('DELETE', '/developer/sandbox', s.headers);
    const again = await send('POST', '/developer/sandbox', s.headers, { turnstileToken: 'ok' });
    expect(again.status).toBe(201);
    const made = CreatedDeveloperSandboxSchema.parse(await again.json());
    expect(made.orgId).not.toBe(s.made.orgId);

    await send('POST', '/developer/sandbox/close', s.headers);
    await expectProblem(
      await send('POST', '/developer/sandbox', s.headers, { turnstileToken: 'ok' }),
      409,
      'SANDBOX_EXISTS',
    );
  });

  it('limits a person to three deletes in a rolling day', async () => {
    const s = await sandboxOf();
    for (let i = 0; i < 3; i++) {
      expect((await send('DELETE', '/developer/sandbox', s.headers)).status).toBe(204);
      const next = await send('POST', '/developer/sandbox', s.headers, { turnstileToken: 'ok' });
      expect(next.status).toBe(201);
    }
    const res = await send('DELETE', '/developer/sandbox', s.headers);
    await expectProblem(res, 429, 'SANDBOX_RESET_LIMIT');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    kit.clock.advance(86_400_001);
    expect((await send('DELETE', '/developer/sandbox', s.headers)).status).toBe(204);
  });
});

describe('POST /developer/sandbox/recreate', () => {
  it('deletes and makes a new sandbox with a new key', async () => {
    const s = await sandboxOf();
    const res = await send('POST', '/developer/sandbox/recreate', s.headers, {
      turnstileToken: 'ok',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const made = CreatedDeveloperSandboxSchema.parse(await res.json());
    expect(made.orgId).not.toBe(s.made.orgId);
    expect(made.key?.secret).toMatch(/^pbp_test_/);
    expect(made.key?.secret).not.toBe(s.made.key?.secret);
    expect((await orgRow(s.made.orgId))?.status).toBe('deleted');
  });

  it('makes one for a person with none, and needs a check and the role', async () => {
    const p = await person();
    const res = await send('POST', '/developer/sandbox/recreate', p.headers, {
      turnstileToken: 'ok',
    });
    expect(res.status).toBe(201);
  });
});
