import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { type BroadcastAuth, type BroadcastKit, broadcastAuth } from '../broadcasts/test-kit.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import {
  DAY,
  moveKit,
  moveOf,
  opRow,
  orgWithPasses,
  replacement,
  startAndRun,
} from './identity-move-test-fixtures.ts';

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

const BASE = '/api/v1/platform/apple/identity-moves';
let kit: BroadcastKit;
let auth: BroadcastAuth;
let app: ReturnType<typeof createApp>;
let seq = 0;
beforeAll(async () => {
  kit = await moveKit();
  auth = await broadcastAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const key = () => ({ 'idempotency-key': `mv-${++seq}` });
const call = (
  path: string,
  headers: Record<string, string>,
  init: { method?: string; body?: unknown } = {},
) =>
  app.request(
    `${BASE}${path}`,
    {
      method: init.method ?? 'GET',
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    },
    kit.env,
  );
const query = (orgId: string, to: string | null = SECOND_ID) =>
  `/preview?orgId=${orgId}&fromIdentityId=platform${to ? `&toIdentityId=${to}` : ''}`;
const start = (headers: Record<string, string>, orgId: string, to: string | null = SECOND_ID) =>
  call('', headers, {
    method: 'POST',
    body: { orgId, fromIdentityId: 'platform', ...(to ? { toIdentityId: to } : {}) },
  });
const paramsRows = (orgId: string) =>
  all(kit.env.DB, 'SELECT 1 FROM identity_moves WHERE org_id = ?', [orgId]);

/** Everyone the routes must refuse: a member, a key, a stale step-up, no session, no CSRF. */
async function refusals() {
  const stale = await makeSession(kit.fx, {
    userId: 'admin-1',
    roles: ['admin', 'user'],
    authTime: kit.clock.now() - 11 * 60_000,
  });
  const { 'x-csrf-token': _csrf, ...noCsrf } = auth.admin();
  return {
    member: auth.user(),
    key: await auth.apiKey({ orgId: null, scopes: ['passes:read', 'passes:write'] }),
    stale: { ...stale.headers, origin: 'https://wallet.test' },
    noCsrf,
  };
}

describe('GET /identity-moves/preview', () => {
  it('counts what would move and why the rest stays', async () => {
    const { org, passes } = await orgWithPasses(kit, 3);
    const connection = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'c', 1, 1)",
      [connection, org.id],
    );
    await run(kit.env.DB, "UPDATE passes SET connection_id = ?, external_ref = 'r1' WHERE id = ?", [
      connection,
      passes[0]?.id ?? '',
    ]);
    const res = await call(query(org.id), auth.admin());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      toIdentityId: SECOND_ID,
      passes: 2,
      kept: { connection: 1 },
    });
    expect(await paramsRows(org.id)).toHaveLength(0);
  });

  it('refuses a member, a key, no session, the same identity, an unknown org and a bad query', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const r = await refusals();
    await expectProblem(await call(query(org.id), r.member), 403, 'FORBIDDEN');
    expect((await call(query(org.id), r.key)).status).toBeGreaterThanOrEqual(401);
    expect((await call(query(org.id), r.key)).status).toBeLessThan(500);
    expect((await call(query(org.id), {})).status).toBe(401);
    await expectProblem(
      await call(query(org.id, 'platform'), auth.admin()),
      409,
      'IDENTITY_MOVE_SAME',
    );
    await expectProblem(await call(query('no-org'), auth.admin()), 404, 'ORG_NOT_FOUND');
    expect((await call('/preview', auth.admin())).status).toBe(422);
  });
});

describe('POST /identity-moves', () => {
  it('starts a move: 202 with the operation, and a replay answers the same one', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const headers = { ...auth.admin(), ...key() };
    const first = await start(headers, org.id);
    expect(first.status).toBe(202);
    const op = (await first.json()) as { id: string; kind: string };
    expect(op.kind).toBe('identity.move');
    const replay = await start(headers, org.id);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { id: string }).id).toBe(op.id);
    expect(await paramsRows(org.id)).toHaveLength(1);
    await expectProblem(
      await call('', headers, {
        method: 'POST',
        body: { orgId: org.id, fromIdentityId: 'platform' },
      }),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses every caller but a platform admin session with step-up, CSRF and a key', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const r = await refusals();
    await expectProblem(await start(auth.admin(), org.id), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    await expectProblem(await start({ ...r.member, ...key() }, org.id), 403, 'FORBIDDEN');
    expect((await start({ ...r.key, ...key() }, org.id)).status).toBeGreaterThanOrEqual(401);
    expect((await start({ ...r.key, ...key() }, org.id)).status).toBeLessThan(500);
    expect((await start(key(), org.id)).status).toBe(401);
    await expectProblem(await start({ ...r.stale, ...key() }, org.id), 403, 'STEP_UP_REQUIRED');
    expect((await start({ ...r.noCsrf, ...key() }, org.id)).status).toBe(403);
    await expectProblem(
      await start({ ...auth.admin(), ...key() }, org.id, 'platform'),
      409,
      'IDENTITY_MOVE_SAME',
    );
    await expectProblem(await start({ ...auth.admin(), ...key() }, 'no-org'), 404, 'ORG_NOT_FOUND');
    expect(
      (await call('', { ...auth.admin(), ...key() }, { method: 'POST', body: {} })).status,
    ).toBe(422);
    expect(await paramsRows(org.id)).toHaveLength(0);
  });

  it('gives no token a way to read, retry or cancel the operation', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const op = (await (await start({ ...auth.admin(), ...key() }, org.id)).json()) as {
      id: string;
    };
    const token = await auth.apiKey({
      orgId: null,
      scopes: ['passes:read', 'passes:write', 'templates:read'],
    });
    for (const [path, method] of [
      [`${op.id}`, 'GET'],
      [`${op.id}/cancel`, 'POST'],
      [`${op.id}/retry`, 'POST'],
    ] as const) {
      const res = await app.request(
        `/api/v1/operations/${path}`,
        { method, headers: { ...token, ...key() } },
        kit.env,
      );
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(500);
    }
    expect((await opRow(kit, op.id)).status).toBe('queued');
  });
});

describe('GET /identity-moves and POST /identity-moves/{moveId}/arm', () => {
  async function moved() {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as NonNullable<(typeof passes)[0]>;
    const op = await startAndRun(kit, org.id);
    return { org, old, op, next: await replacement(kit, old) };
  }
  const list = async (qs: string) =>
    (await (await call(qs, auth.admin())).json()) as {
      items: { id: string; state: string; reason: string | null; oldPassId: string }[];
      nextCursor: string | null;
    };

  it('lists rows with state and reason, filtered, including kept_both and unarmed', async () => {
    const a = await moved();
    const b = await moved();
    await run(
      kit.env.DB,
      "UPDATE pass_moves SET state = 'kept_both', reason = 'connection' WHERE old_pass_id = ?",
      [a.old.id],
    );
    await run(kit.env.DB, "UPDATE pass_moves SET reason = 'unarmed' WHERE old_pass_id = ?", [
      b.old.id,
    ]);
    const both = await list(`?orgId=${a.org.id}&state=kept_both`);
    expect(both.items.map((i) => [i.oldPassId, i.state, i.reason])).toEqual([
      [a.old.id, 'kept_both', 'connection'],
    ]);
    const unarmed = await list(`?operationId=${b.op.id}&reason=unarmed`);
    expect(unarmed.items.map((i) => i.oldPassId)).toEqual([b.old.id]);
    const paged = await list(`?orgId=${a.org.id}&limit=1`);
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).toBeNull();
  });

  it('refuses a member, a key and no session on the list', async () => {
    const r = await refusals();
    await expectProblem(await call('', r.member), 403, 'FORBIDDEN');
    expect((await call('', r.key)).status).toBeGreaterThanOrEqual(401);
    expect((await call('', r.key)).status).toBeLessThan(500);
    expect((await call('', {})).status).toBe(401);
  });

  it('arms a row whose replacement registered on another device, then refuses a repeat', async () => {
    const { old, next } = await moved();
    await kit.device(old, 'dev-1', 'o'.repeat(64));
    await kit.device(next, 'dev-9', 'n'.repeat(64));
    const row = await moveOf(kit, old.id);
    const res = await call(`/${row.id}/arm`, { ...auth.admin(), ...key() }, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moveId: row.id, armed: true });
    const after = await moveOf(kit, old.id);
    expect(after.void_at).toBe(kit.clock.now() + DAY);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 AS n FROM audit_log WHERE action = 'identity.move_armed' AND target_id = ?",
        [old.id],
      ),
    ).not.toBeNull();
    await expectProblem(
      await call(`/${row.id}/arm`, { ...auth.admin(), ...key() }, { method: 'POST' }),
      409,
      'IDENTITY_MOVE_CONFLICT',
    );
  });

  it('refuses arming with no registration, an unknown row, and every wrong caller', async () => {
    const { old } = await moved();
    const row = await moveOf(kit, old.id);
    const r = await refusals();
    const arm = (headers: Record<string, string>, id = row.id) =>
      call(`/${id}/arm`, headers, { method: 'POST' });
    await expectProblem(await arm({ ...auth.admin(), ...key() }), 409, 'IDENTITY_MOVE_CONFLICT');
    await expectProblem(await arm({ ...auth.admin(), ...key() }, 'nope'), 404, 'NOT_FOUND');
    await expectProblem(await arm(auth.admin()), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    await expectProblem(await arm({ ...r.member, ...key() }), 403, 'FORBIDDEN');
    expect((await arm({ ...r.key, ...key() })).status).toBeGreaterThanOrEqual(401);
    expect((await arm({ ...r.key, ...key() })).status).toBeLessThan(500);
    expect((await arm(key())).status).toBe(401);
    await expectProblem(await arm({ ...r.stale, ...key() }), 403, 'STEP_UP_REQUIRED');
    expect((await arm({ ...r.noCsrf, ...key() })).status).toBe(403);
    expect((await moveOf(kit, old.id)).void_at).toBeNull();
  });
});
