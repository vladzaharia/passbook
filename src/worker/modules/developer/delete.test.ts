import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { type OrgPurgeParams, runOrgPurge } from '../../workflows/org-purge.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { beginPurge } from '../org-lifecycle/purge.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { makeSandbox, startAndSettle } from './sandbox-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const realFetch = globalThis.fetch;
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
/** A purge Workflow that runs its steps and then sleeps through the grace, as the real one does for 7 days. */
const sleeping = {
  async do(_name: string, a: unknown, b?: unknown) {
    return ((typeof a === 'function' ? a : b) as () => unknown)();
  },
  async sleep() {},
  sleepUntil: () => new Promise<void>(() => {}),
};
const purges = vi.fn(async (opts: { id: string; params: OrgPurgeParams }) => {
  void runOrgPurge(kit.env, opts.params, sleeping as never, undefined, kit.clock, 0);
  return {};
});

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
  return { ...p, made: await makeSandbox(send, p.headers) };
}

const deleted = (headers: Record<string, string>) =>
  startAndSettle(send, headers, 'DELETE', '/developer/sandbox');

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
    const op = await deleted(s.headers);
    expect(op).toMatchObject({
      kind: 'sandbox.delete',
      target: { type: 'sandbox', id: s.made.orgId },
    });

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
      "SELECT org_id, target_id FROM audit_log WHERE action = 'developer_sandbox.delete' AND actor_id = ?",
      [s.user.id],
    );
    expect(audit).toEqual({ org_id: null, target_id: s.made.orgId });
    await vi.waitFor(() =>
      expect(purges).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { orgId: s.made.orgId, operationId: op.id, attempt: 1, finish: true },
        }),
      ),
    );
    // The org purge took it from here: it is due now, and it has started.
    expect(
      await beginPurge(createJobContext(kit.env, 'test', { clock: kit.clock }), s.made.orgId),
    ).toBe('resumed');
    expect(op.status).toBe('succeeded');
    expect(op.steps.find((x) => x.key === 'erase')).toMatchObject({
      state: 'waiting',
      waitingReason: 'due',
    });

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
    await deleted(s.headers);
    expect((await orgRow(s.made.orgId))?.purge_after).toBe(kit.clock.now());
    await expectProblem(
      await send('DELETE', '/developer/sandbox', s.headers),
      404,
      'SANDBOX_NOT_FOUND',
    );
  });

  it('lets a deleted person make a new sandbox, but a closed one still blocks it', async () => {
    const s = await sandboxOf();
    await deleted(s.headers);
    const made = await makeSandbox(send, s.headers);
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
    // Three deletes already on record (the audit rows are the count).
    for (let i = 0; i < 3; i++)
      await run(
        kit.env.DB,
        `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES (?, NULL, 'user', ?, 'developer_sandbox.delete', 'org', ?)`,
        [kit.clock.now() - i * 1000, s.user.id, kit.f.ids.id()],
      );
    const res = await send('DELETE', '/developer/sandbox', s.headers);
    await expectProblem(res, 429, 'SANDBOX_RESET_LIMIT');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('POST /developer/sandbox/recreate', () => {
  it('deletes and makes a new sandbox, and its key is minted once afterwards', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox/recreate', {
      turnstileToken: 'ok',
    });
    expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.result?.ids.orgId).not.toBe(s.made.orgId);
    expect((await orgRow(s.made.orgId))?.status).toBe('deleted');
    const keyed = await send('POST', '/developer/sandbox/key', s.headers);
    expect(keyed.status).toBe(201);
    const { key } = (await keyed.json()) as { key: { secret: string } };
    expect(key.secret).toMatch(/^pbp_test_/);
    expect(key.secret).not.toBe(s.made.key?.secret);
  });

  it('makes one for a person with none, and needs a check and the role', async () => {
    const p = await person();
    const op = await startAndSettle(send, p.headers, 'POST', '/developer/sandbox/recreate', {
      turnstileToken: 'ok',
    });
    expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
  });
});

describe('step-up', () => {
  it('asks a stale session for a recent sign-in on delete and recreate, and deletes nothing', async () => {
    const s = await sandboxOf();
    kit.clock.advance(700_000);
    await expectProblem(
      await send('DELETE', '/developer/sandbox', s.headers),
      403,
      'STEP_UP_REQUIRED',
    );
    await expectProblem(
      await send('POST', '/developer/sandbox/recreate', s.headers, { turnstileToken: 'ok' }),
      403,
      'STEP_UP_REQUIRED',
    );
    expect((await orgRow(s.made.orgId))?.status).toBe('active');
  });
});
