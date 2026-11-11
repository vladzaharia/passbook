import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiKeyFixture,
  editApiKeyIdentity,
  editSessionAuthority,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import {
  BroadcastItemListSchema,
  BroadcastListSchema,
  BroadcastPreviewSchema,
  BroadcastSchema,
} from '../../../shared/contracts/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { startDueBroadcasts } from './start.ts';
import { type BroadcastKit, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
type Headers = Record<string, string>;
type Member = { userId: string; membershipId: string; session: SessionFixture };
let kit: BroadcastKit;
let app: OpenAPIHono<AppBindings>;
let manager: Member;
let otherOrg: string;

async function membership(userId: string, orgId: string, roles: OrgRole[]): Promise<string> {
  const invitationId = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations
       (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [
      invitationId,
      orgId,
      JSON.stringify(roles),
      kit.fx.ids.token(),
      now,
      now + 3_600_000,
      now,
      userId,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

async function member(orgId: string, role: OrgRole = 'org_admin'): Promise<Member> {
  const user = await makeUser(kit.fx);
  const membershipId = await membership(user.id, orgId, [role]);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  return { userId: user.id, membershipId, session };
}

beforeEach(async () => {
  kit = await broadcastKit();
  otherOrg = (await makeOrg(kit.fx, { name: 'Another tenant' })).id;
  manager = await member(kit.org.id);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

async function call(
  method: string,
  path: string,
  headers: Headers,
  body?: unknown,
): Promise<Response> {
  return app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
}

function message(orgId = kit.org.id, extra: Record<string, unknown> = {}) {
  return {
    orgId,
    kind: 'message',
    target: { templateIds: [kit.messaging.id] },
    patch: { message: 'Tenant message' },
    send: 'draft',
    ...extra,
  };
}

async function draft(headers = manager.session.headers, orgId = kit.org.id) {
  const res = await call('POST', '/broadcasts', headers, message(orgId));
  expect(res.status).toBe(201);
  return BroadcastSchema.parse(await res.json());
}

async function ids(headers: Headers, orgId?: string) {
  const query =
    orgId === undefined ? '?limit=200' : `?orgId=${encodeURIComponent(orgId)}&limit=200`;
  const res = await call('GET', `/broadcasts${query}`, headers);
  expect(res.status).toBe(200);
  return BroadcastListSchema.parse(await res.json()).items.map((item) => item.id);
}

async function preview(headers: Headers, orgId = kit.org.id) {
  return call('POST', '/broadcasts/preview', headers, {
    orgId,
    target: { templateIds: [kit.messaging.id] },
  });
}

async function persisted(orgId = kit.org.id) {
  const db = kit.env.DB;
  return {
    broadcasts: await all(db, 'SELECT * FROM broadcasts WHERE org_id = ? ORDER BY id', [orgId]),
    items: await all(
      db,
      `SELECT i.* FROM broadcast_items i JOIN broadcasts b ON b.id = i.broadcast_id
      WHERE b.org_id = ? ORDER BY i.broadcast_id, i.pass_id`,
      [orgId],
    ),
    passes: await all(db, 'SELECT * FROM passes WHERE org_id = ? ORDER BY id', [orgId]),
    versions: await all(
      db,
      `SELECT v.* FROM pass_versions v JOIN passes p ON p.id = v.pass_id
      WHERE p.org_id = ? ORDER BY v.pass_id, v.version`,
      [orgId],
    ),
    events: await all(db, 'SELECT * FROM pass_events WHERE org_id = ? ORDER BY id', [orgId]),
    audits: await all(
      db,
      "SELECT * FROM audit_log WHERE org_id = ? AND action LIKE 'broadcast.%' ORDER BY id",
      [orgId],
    ),
    workflows: await all(db, 'SELECT * FROM workflow_runs WHERE org_id = ? ORDER BY instance_id', [
      orgId,
    ]),
    launched: kit.broadcast.created.slice(),
  };
}

/** Intervene after the guarded statements are prepared, immediately before the real D1 batch. */
async function atBroadcastCommit<T>(
  intervene: (db: D1Database) => Promise<void>,
  request: () => Promise<T>,
) {
  const db = kit.env.DB;
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const isBroadcastWrite = (sql: string) =>
    /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+broadcasts\b/i.test(sql);
  let hits = 0;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          sqlOf.set(statement, sql);
          return new Proxy(statement, {
            get(prepared, field) {
              if (field === 'bind') {
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              }
              const value = Reflect.get(prepared, field, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (
            hits === 0 &&
            statements.some((statement) => isBroadcastWrite(sqlOf.get(statement) ?? ''))
          ) {
            hits++;
            await intervene(db);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await request();
    expect(hits, 'the broadcast mutation batch was reached').toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

describe('tenant broadcast reads', () => {
  it('requires an explicit organization for sessions and platform keys, not a platform role', async () => {
    const own = await draft();
    const platformUser = await makeUser(kit.fx);
    const platformAdmin = await makeSession(kit.fx, {
      userId: platformUser.id,
      roles: ['admin', 'user'],
    });
    const platformKey = await makeApiKey(kit.fx, { scopes: ['messages:write'] });
    for (const headers of [manager.session.headers, platformAdmin.headers, platformKey.headers]) {
      expect((await call('GET', '/broadcasts', headers)).status).toBe(422);
      expect((await call('GET', '/broadcasts?orgId=', headers)).status).toBe(422);
    }
    expect(
      (await call('GET', `/broadcasts?orgId=${kit.org.id}`, platformAdmin.headers)).status,
    ).toBe(403);
    expect((await call('GET', `/broadcasts/${own.id}`, platformAdmin.headers)).status).toBe(404);
    expect((await call('GET', `/broadcasts?orgId=${kit.org.id}`, {})).status).toBe(401);
  });

  it('lets read-only members list, inspect, preview and read actual outcomes in their org', async () => {
    const reader = await member(kit.org.id, 'read_only');
    const pass = await kit.makePass();
    await kit.makePass({ mode: 'test' });
    await kit.makePass({ mode: 'test' });
    await kit.makePass({ orgId: otherOrg });
    const own = await draft();
    await run(
      kit.env.DB,
      "INSERT INTO broadcast_items (broadcast_id, pass_id, outcome, silent) VALUES (?, ?, 'updated', 0)",
      [own.id, pass.id],
    );

    expect(await ids(reader.session.headers, kit.org.id)).toEqual([own.id]);
    const detail = await call('GET', `/broadcasts/${own.id}`, reader.session.headers);
    expect(detail.status).toBe(200);
    expect(BroadcastSchema.parse(await detail.json())).toMatchObject({
      id: own.id,
      orgId: kit.org.id,
    });
    const count = await preview(reader.session.headers);
    expect(count.status).toBe(200);
    expect(BroadcastPreviewSchema.parse(await count.json())).toMatchObject({ targeted: 1 });
    const testCount = await preview({ ...reader.session.headers, 'x-passbook-mode': 'test' });
    expect(testCount.status).toBe(200);
    expect(BroadcastPreviewSchema.parse(await testCount.json())).toMatchObject({ targeted: 2 });
    const outcomes = await call('GET', `/broadcasts/${own.id}/items`, reader.session.headers);
    expect(outcomes.status).toBe(200);
    expect(BroadcastItemListSchema.parse(await outcomes.json()).items).toEqual([
      expect.objectContaining({ passId: pass.id, outcome: 'updated', silent: false }),
    ]);
    expect(
      await first(
        kit.env.DB,
        'SELECT outcome, silent FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?',
        [own.id, pass.id],
      ),
    ).toEqual({ outcome: 'updated', silent: 0 });
  });

  it('masks foreign by-id reads and writes while denying foreign list, preview and create', async () => {
    await membership(manager.userId, otherOrg, ['org_admin']);
    const foreign = await draft(manager.session.headers, otherOrg);
    const foreignPass = await kit.makePass({ orgId: otherOrg });
    await run(
      kit.env.DB,
      "INSERT INTO broadcast_items (broadcast_id, pass_id, outcome, silent) VALUES (?, ?, 'failed', 0)",
      [foreign.id, foreignPass.id],
    );
    const reader = await member(kit.org.id, 'org_admin');
    const headers = reader.session.headers;
    const before = await persisted(otherOrg);
    expect((await call('GET', `/broadcasts?orgId=${otherOrg}`, headers)).status).toBe(403);
    expect((await preview(headers, otherOrg)).status).toBe(403);
    expect((await call('POST', '/broadcasts', headers, message(otherOrg))).status).toBe(403);
    for (const [method, path, body] of [
      ['GET', `/broadcasts/${foreign.id}`, undefined],
      ['GET', `/broadcasts/${foreign.id}/items`, undefined],
      ['PATCH', `/broadcasts/${foreign.id}`, message()],
      ['POST', `/broadcasts/${foreign.id}/send`, {}],
      ['POST', `/broadcasts/${foreign.id}/cancel`, undefined],
      ['POST', `/broadcasts/${foreign.id}/retry`, undefined],
    ] as const) {
      expect((await call(method, path, headers, body)).status, path).toBe(404);
    }
    expect(await persisted(otherOrg)).toEqual(before);
  });

  it('lists only the current mode, allows session by-id reads in either mode, and blocks cross-mode writes', async () => {
    const live = await draft();
    const testHeaders = { ...manager.session.headers, 'x-passbook-mode': 'test' };
    const test = await draft(testHeaders);
    const cancelled = await draft();
    expect(
      (await call('POST', `/broadcasts/${cancelled.id}/cancel`, manager.session.headers)).status,
    ).toBe(200);
    expect(await ids(manager.session.headers, kit.org.id)).toEqual(
      expect.arrayContaining([live.id, cancelled.id]),
    );
    expect(await ids(manager.session.headers, kit.org.id)).not.toContain(test.id);
    expect(await ids(testHeaders, kit.org.id)).toEqual([test.id]);
    expect((await call('GET', `/broadcasts/${live.id}`, testHeaders)).status).toBe(200);
    expect((await call('GET', `/broadcasts/${live.id}/items`, testHeaders)).status).toBe(200);
    expect((await call('GET', `/broadcasts/${test.id}`, manager.session.headers)).status).toBe(200);
    const before = await persisted();
    for (const [method, path, body] of [
      ['PATCH', `/broadcasts/${live.id}`, message()],
      ['POST', `/broadcasts/${live.id}/send`, {}],
      ['POST', `/broadcasts/${live.id}/cancel`, undefined],
      ['POST', `/broadcasts/${cancelled.id}/retry`, undefined],
    ] as const) {
      const response = await call(method, path, testHeaders, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'MODE_MISMATCH' });
    }
    expect(await persisted()).toEqual(before);
  });
});

describe('tenant broadcast mutations', () => {
  it('still requires CSRF protection for a tenant session mutation', async () => {
    const headers = { ...manager.session.headers };
    delete headers['x-csrf-token'];
    const before = await persisted();
    const response = await call('POST', '/broadcasts', headers, message());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CSRF_TOKEN' });
    expect(await persisted()).toEqual(before);
  });

  it('denies every mutation to a read-only member without changing persisted data', async () => {
    const reader = await member(kit.org.id, 'read_only');
    const editable = await draft();
    const cancelled = await draft();
    expect(
      (await call('POST', `/broadcasts/${cancelled.id}/cancel`, manager.session.headers)).status,
    ).toBe(200);
    const before = await persisted();
    for (const [method, path, body] of [
      ['POST', '/broadcasts', message()],
      ['POST', '/broadcasts', message(kit.org.id, { send: 'now' })],
      [
        'POST',
        '/broadcasts',
        message(kit.org.id, { send: 'schedule', at: kit.clock.now() + 60_000 }),
      ],
      [
        'PATCH',
        `/broadcasts/${editable.id}`,
        message(kit.org.id, { patch: { message: 'Not allowed' } }),
      ],
      ['POST', `/broadcasts/${editable.id}/send`, {}],
      ['POST', `/broadcasts/${editable.id}/send`, { at: kit.clock.now() + 60_000 }],
      ['POST', `/broadcasts/${editable.id}/cancel`, undefined],
      ['POST', `/broadcasts/${cancelled.id}/retry`, undefined],
    ] as const) {
      expect((await call(method, path, reader.session.headers, body)).status, path).toBe(403);
    }
    expect(await persisted()).toEqual(before);
  });

  it('allows a non-platform pass operator to read, create, edit, schedule, cancel, send and retry', async () => {
    const operator = await member(kit.org.id, 'pass_operator');
    const headers = operator.session.headers;
    await kit.makePass();
    const item = await draft(headers);
    expect(await ids(headers, kit.org.id)).toContain(item.id);
    expect((await call('GET', `/broadcasts/${item.id}`, headers)).status).toBe(200);
    expect((await call('GET', `/broadcasts/${item.id}/items`, headers)).status).toBe(200);
    const count = await preview(headers);
    expect(count.status).toBe(200);
    expect(BroadcastPreviewSchema.parse(await count.json()).targeted).toBe(1);
    const changed = await call(
      'PATCH',
      `/broadcasts/${item.id}`,
      headers,
      message(kit.org.id, { patch: { message: 'Changed' } }),
    );
    expect(changed.status).toBe(200);
    expect(BroadcastSchema.parse(await changed.json())).toMatchObject({
      patch: { message: 'Changed' },
      state: 'draft',
    });
    const at = kit.clock.now() + 60_000;
    const scheduled = await call('POST', `/broadcasts/${item.id}/send`, headers, { at });
    expect(scheduled.status).toBe(200);
    expect(BroadcastSchema.parse(await scheduled.json())).toMatchObject({ state: 'scheduled', at });
    const cancelled = await call('POST', `/broadcasts/${item.id}/cancel`, headers);
    expect(cancelled.status).toBe(200);
    expect(BroadcastSchema.parse(await cancelled.json()).state).toBe('cancelled');
    const retry = await call('POST', `/broadcasts/${item.id}/retry`, headers);
    expect(retry.status).toBe(201);
    const retried = BroadcastSchema.parse(await retry.json());
    expect(retried).toMatchObject({
      orgId: kit.org.id,
      state: 'sending',
      patch: { message: 'Changed' },
    });
    expect(retried.id).not.toBe(item.id);
    expect(
      await first(kit.env.DB, 'SELECT state, at, patch FROM broadcasts WHERE id = ?', [item.id]),
    ).toMatchObject({ state: 'cancelled', at, patch: JSON.stringify({ message: 'Changed' }) });
    expect(
      await first(kit.env.DB, 'SELECT state, org_id FROM broadcasts WHERE id = ?', [retried.id]),
    ).toEqual({ state: 'sending', org_id: kit.org.id });
    expect(kit.broadcast.created.map((instance) => instance.id)).toContain(
      `broadcast-${retried.id}`,
    );

    const now = await draft(headers);
    const sent = await call('POST', `/broadcasts/${now.id}/send`, headers, {});
    expect(sent.status).toBe(200);
    expect(BroadcastSchema.parse(await sent.json()).state).toBe('sending');
    expect(kit.broadcast.created.map((instance) => instance.id)).toContain(`broadcast-${now.id}`);
    const directlyScheduled = await call(
      'POST',
      '/broadcasts',
      headers,
      message(kit.org.id, { send: 'schedule', at: at + 60_000 }),
    );
    expect(directlyScheduled.status).toBe(201);
    expect(BroadcastSchema.parse(await directlyScheduled.json())).toMatchObject({
      state: 'scheduled',
      at: at + 60_000,
    });
  });
});

describe('API-key scope, organization and mode', () => {
  it('requires messages:write, and passes:read for outcomes or passes:write for changes', async () => {
    const noMessages = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
    });
    const onlyMessages = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['messages:write'],
    });
    const full = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:read', 'passes:write'],
    });
    const own = await draft(onlyMessages.headers);
    const before = await persisted();
    expect((await call('GET', '/broadcasts', noMessages.headers)).status).toBe(403);
    expect((await call('POST', '/broadcasts', noMessages.headers, message())).status).toBe(403);
    expect((await call('GET', `/broadcasts/${own.id}/items`, onlyMessages.headers)).status).toBe(
      403,
    );
    const change = message(kit.org.id, { kind: 'change', patch: { gate: 'A1' } });
    expect((await call('POST', '/broadcasts', onlyMessages.headers, change)).status).toBe(403);
    expect(await persisted()).toEqual(before);
    expect((await call('GET', `/broadcasts/${own.id}/items`, full.headers)).status).toBe(200);
    const created = await call('POST', '/broadcasts', full.headers, change);
    expect(created.status).toBe(201);
    const changed = BroadcastSchema.parse(await created.json());
    const unchanged = await persisted();
    expect(
      (await call('POST', `/broadcasts/${changed.id}/send`, onlyMessages.headers, {})).status,
    ).toBe(403);
    expect(
      (await call('PATCH', `/broadcasts/${changed.id}`, onlyMessages.headers, message())).status,
    ).toBe(403);
    expect(await persisted()).toEqual(unchanged);
    expect(
      (await call('POST', `/broadcasts/${changed.id}/cancel`, onlyMessages.headers)).status,
    ).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT state FROM broadcasts WHERE id = ?', [changed.id]),
    ).toEqual({ state: 'cancelled' });
  });

  it('pins org keys to their own organization and mode, including by-id access', async () => {
    await membership(manager.userId, otherOrg, ['org_admin']);
    const foreign = await draft(manager.session.headers, otherOrg);
    const liveKey = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:read'],
    });
    const testKey = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:read'],
      mode: 'test',
    });
    const live = await draft(liveKey.headers);
    const test = await draft(testKey.headers);
    expect(live.mode).toBe('live');
    expect(test.mode).toBe('test');
    expect(await ids(liveKey.headers)).toContain(live.id);
    expect(await ids(liveKey.headers)).not.toContain(test.id);
    expect(await ids(liveKey.headers)).not.toContain(foreign.id);
    expect(await ids(testKey.headers)).toEqual([test.id]);
    const misleadingMode = { ...liveKey.headers, 'x-passbook-mode': 'test' };
    expect(await ids(misleadingMode)).toContain(live.id);
    expect(await ids(misleadingMode)).not.toContain(test.id);
    expect((await call('GET', `/broadcasts?orgId=${otherOrg}`, liveKey.headers)).status).toBe(403);
    expect((await preview(liveKey.headers, otherOrg)).status).toBe(403);
    expect((await call('POST', '/broadcasts', liveKey.headers, message(otherOrg))).status).toBe(
      403,
    );
    const before = await persisted();
    for (const [headers, id] of [
      [liveKey.headers, foreign.id],
      [testKey.headers, live.id],
    ] as const) {
      for (const [method, suffix, body] of [
        ['GET', '', undefined],
        ['GET', '/items', undefined],
        ['POST', '/send', {}],
        ['POST', '/cancel', undefined],
        ['POST', '/retry', undefined],
        ['PATCH', '', message()],
      ] as const) {
        expect((await call(method, `/broadcasts/${id}${suffix}`, headers, body)).status).toBe(404);
      }
    }
    expect(await persisted()).toEqual(before);
  });

  it('allows platform-wide keys to select either org but never list all orgs', async () => {
    const key = await makeApiKey(kit.fx, { scopes: ['messages:write'] });
    const own = await draft(key.headers);
    const foreign = await draft(key.headers, otherOrg);
    expect((await call('GET', '/broadcasts', key.headers)).status).toBe(422);
    expect(await ids(key.headers, kit.org.id)).toEqual([own.id]);
    expect(await ids(key.headers, otherOrg)).toEqual([foreign.id]);
    expect((await call('GET', `/broadcasts/${foreign.id}`, key.headers)).status).toBe(200);
    expect((await preview(key.headers, otherOrg)).status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT org_id, mode FROM broadcasts WHERE id = ?', [foreign.id]),
    ).toEqual({ org_id: otherOrg, mode: 'live' });
    const testKey = await makeApiKey(kit.fx, { scopes: ['messages:write'], mode: 'test' });
    const test = await draft(testKey.headers, otherOrg);
    expect(test.mode).toBe('test');
    expect((await call('GET', '/broadcasts', testKey.headers)).status).toBe(422);
    expect(await ids(testKey.headers, otherOrg)).toEqual([test.id]);
    expect((await call('GET', `/broadcasts/${foreign.id}`, testKey.headers)).status).toBe(404);
    expect((await call('POST', `/broadcasts/${foreign.id}/send`, testKey.headers, {})).status).toBe(
      404,
    );
  });
});

type Operation = 'create' | 'update' | 'send' | 'schedule' | 'cancel' | 'retry';
const operations: Operation[] = ['create', 'update', 'send', 'schedule', 'cancel', 'retry'];

async function operation(action: Operation, id: string, headers: Headers) {
  switch (action) {
    case 'create':
      return call('POST', '/broadcasts', headers, message());
    case 'update':
      return call(
        'PATCH',
        `/broadcasts/${id}`,
        headers,
        message(kit.org.id, { patch: { message: 'Changed after authorization' } }),
      );
    case 'send':
      return call('POST', `/broadcasts/${id}/send`, headers, {});
    case 'schedule':
      return call('POST', `/broadcasts/${id}/send`, headers, { at: kit.clock.now() + 60_000 });
    case 'cancel':
      return call('POST', `/broadcasts/${id}/cancel`, headers);
    case 'retry':
      return call('POST', `/broadcasts/${id}/retry`, headers);
  }
}

async function operationTarget(action: Operation) {
  const item = await draft();
  if (action === 'retry') {
    expect(
      (await call('POST', `/broadcasts/${item.id}/cancel`, manager.session.headers)).status,
    ).toBe(200);
  }
  return item.id;
}

describe('authority at the D1 mutation commit', () => {
  for (const action of operations) {
    it.each(['session', 'membership'] as const)(
      `fences ${action} when its %s is revoked after authorization`,
      async (kind) => {
        const id = await operationTarget(action);
        const before = await persisted();
        const sessionId = await sha256Hex(manager.session.cookieValue);
        const response = await atBroadcastCommit(
          async (db) => {
            if (kind === 'session') {
              expect(
                await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                  kit.clock.now(),
                  sessionId,
                ]),
              ).toEqual({ changes: 1 });
            } else {
              expect(
                await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                  kit.clock.now(),
                  manager.membershipId,
                ]),
              ).toEqual({ changes: 1 });
            }
          },
          () => operation(action, id, manager.session.headers),
        );
        expect([403, 409]).toContain(response.status);
        expect(await persisted()).toEqual(before);
      },
    );

    it.each(['revoked', 'scope removed'] as const)(
      `${action} with its API key %s after authorization`,
      async (kind) => {
        const id = await operationTarget(action);
        const key: ApiKeyFixture = await makeApiKey(kit.fx, {
          orgId: kit.org.id,
          scopes: ['messages:write'],
        });
        const before = await persisted();
        const response = await atBroadcastCommit(
          async (db) => {
            if (kind === 'scope removed') {
              // Scopes are immutable (0039): the edit is refused, so authority cannot shrink mid-request.
              await expect(
                run(db, "UPDATE api_keys SET scopes = '[]' WHERE id = ?", [key.id]),
              ).rejects.toThrow('api key identity is immutable');
              return;
            }
            expect(
              await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                key.id,
              ]),
            ).toEqual({ changes: 1 });
          },
          () => operation(action, id, key.headers),
        );
        if (kind === 'scope removed') {
          expect(response.status).toBeLessThan(300);
          return;
        }
        expect([403, 409]).toContain(response.status);
        expect(await persisted()).toEqual(before);
      },
    );
  }

  it.each(['absolute expiry', 'idle expiry'] as const)(
    'fences a send when the session %s changes at commit',
    async (change) => {
      const item = await draft();
      const sessionId = await sha256Hex(manager.session.cookieValue);
      const before = await persisted();
      const response = await atBroadcastCommit(
        async (db) => {
          const result =
            change === 'absolute expiry'
              ? await editSessionAuthority(
                  db,
                  'UPDATE sessions SET expires_at = ? WHERE id_hash = ?',
                  [kit.clock.now(), sessionId],
                )
              : await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
                  kit.clock.now(),
                  sessionId,
                ]);
          expect(result).toEqual({ changes: 1 });
        },
        () => operation('send', item.id, manager.session.headers),
      );
      expect([403, 409]).toContain(response.status);
      expect(await persisted()).toEqual(before);
    },
  );

  // Roles and amr are immutable (0047) and checked once in JS: the edit is refused and the send proceeds.
  it.each([
    ['roles', 'UPDATE sessions SET roles = \'["admin"]\' WHERE id_hash = ?'],
    ['authentication method', "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ?"],
  ] as const)('cannot change the session %s under a send', async (_change, sql) => {
    const item = await draft();
    const sessionId = await sha256Hex(manager.session.cookieValue);
    const response = await atBroadcastCommit(
      async (db) => {
        await expect(run(db, sql, [sessionId])).rejects.toThrow('session authority is immutable');
      },
      () => operation('send', item.id, manager.session.headers),
    );
    expect(response.status).toBeLessThan(300);
  });

  it.each(['expiry', 'organization', 'mode'] as const)(
    'fences a send when the API key %s changes at commit',
    async (change) => {
      const item = await draft();
      const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['messages:write'] });
      const before = await persisted();
      const response = await atBroadcastCommit(
        async (db) => {
          const result =
            change === 'expiry'
              ? await editApiKeyIdentity(db, 'UPDATE api_keys SET expires_at = ? WHERE id = ?', [
                  kit.clock.now(),
                  key.id,
                ])
              : change === 'organization'
                ? await editApiKeyIdentity(db, 'UPDATE api_keys SET org_id = ? WHERE id = ?', [
                    otherOrg,
                    key.id,
                  ])
                : await editApiKeyIdentity(db, "UPDATE api_keys SET mode = 'test' WHERE id = ?", [
                    key.id,
                  ]);
          expect(result).toEqual({ changes: 1 });
        },
        () => operation('send', item.id, key.headers),
      );
      expect([403, 409]).toContain(response.status);
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(['create', 'edit-to-change', 'edit-change', 'send', 'retry'] as const)(
    '%s still runs when a scope edit on a change-capable key is refused at commit',
    async (action) => {
      const key = await makeApiKey(kit.fx, {
        orgId: kit.org.id,
        scopes: ['messages:write', 'passes:write'],
      });
      const change = message(kit.org.id, { kind: 'change', patch: { gate: 'A1' } });
      let id = '';
      if (action !== 'create') {
        const initial = action === 'edit-to-change' ? message() : change;
        const created = await call('POST', '/broadcasts', manager.session.headers, initial);
        expect(created.status).toBe(201);
        id = BroadcastSchema.parse(await created.json()).id;
        if (action === 'retry') {
          expect(
            (await call('POST', `/broadcasts/${id}/cancel`, manager.session.headers)).status,
          ).toBe(200);
        }
      }
      const response = await atBroadcastCommit(
        async (db) => {
          await expect(
            run(db, 'UPDATE api_keys SET scopes = \'["messages:write"]\' WHERE id = ?', [key.id]),
          ).rejects.toThrow('api key identity is immutable');
        },
        () => {
          if (action === 'create') return call('POST', '/broadcasts', key.headers, change);
          if (action === 'edit-to-change' || action === 'edit-change')
            return call('PATCH', `/broadcasts/${id}`, key.headers, change);
          return call(
            'POST',
            `/broadcasts/${id}/${action}`,
            key.headers,
            action === 'send' ? {} : undefined,
          );
        },
      );
      expect(response.status).toBeLessThan(300);
    },
  );

  it.each(['read_only', 'org_admin'] as const)(
    'does not transfer a captured management grant to a replacement %s membership',
    async (role) => {
      const item = await draft();
      const before = await persisted();
      const response = await atBroadcastCommit(
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            manager.membershipId,
          ]);
          await membership(manager.userId, kit.org.id, [role]);
        },
        () => operation('update', item.id, manager.session.headers),
      );
      expect([403, 409]).toContain(response.status);
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(['user', 'organization'] as const)(
    'fences a send when the %s is disabled at commit',
    async (kind) => {
      const item = await draft();
      const before = await persisted();
      const response = await atBroadcastCommit(
        async (db) => {
          const result =
            kind === 'user'
              ? await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [manager.userId])
              : await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
          // A user or organization update also moves its trigger-owned access epoch, which D1 counts.
          expect(result.changes).toBe(2);
        },
        () => operation('send', item.id, manager.session.headers),
      );
      expect([403, 409]).toContain(response.status);
      expect(await persisted()).toEqual(before);
    },
  );
});

it('executes a committed schedule after its originating session is revoked', async () => {
  const pass = await kit.makePass();
  const at = kit.clock.now() + 60_000;
  const response = await call(
    'POST',
    '/broadcasts',
    manager.session.headers,
    message(kit.org.id, { send: 'schedule', at, patch: { message: 'Committed schedule' } }),
  );
  expect(response.status).toBe(201);
  const scheduled = BroadcastSchema.parse(await response.json());
  expect(scheduled.state).toBe('scheduled');
  await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
    kit.clock.now(),
    await sha256Hex(manager.session.cookieValue),
  ]);
  kit.clock.advance(60_001);
  await startDueBroadcasts(jobCtxOf(kit));
  const instanceId = `broadcast-${scheduled.id}`;
  expect(kit.broadcast.created.map((instance) => instance.id)).toContain(instanceId);
  type Step = Parameters<typeof runBroadcast>[3];
  const step: Step = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
  } as unknown as Step;
  expect(await runBroadcast(kit.env, instanceId, { broadcastId: scheduled.id }, step)).toEqual({
    state: 'sent',
  });
  expect((await getPass(kit.env.DB, pass.id, null))?.personalization.message).toBe(
    'Committed schedule',
  );
  expect(
    await first(kit.env.DB, 'SELECT state FROM broadcasts WHERE id = ?', [scheduled.id]),
  ).toEqual({ state: 'sent' });
  expect(
    await first(kit.env.DB, 'SELECT status FROM workflow_runs WHERE instance_id = ?', [instanceId]),
  ).toEqual({ status: 'complete' });
});

it('does not launch a committed schedule once its creator lost the membership', async () => {
  await kit.makePass();
  const at = kit.clock.now() + 60_000;
  const response = await call(
    'POST',
    '/broadcasts',
    manager.session.headers,
    message(kit.org.id, { send: 'schedule', at, patch: { message: 'Removed creator' } }),
  );
  expect(response.status).toBe(201);
  const scheduled = BroadcastSchema.parse(await response.json());
  await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
    kit.clock.now(),
    manager.membershipId,
  ]);
  kit.clock.advance(60_001);
  await startDueBroadcasts(jobCtxOf(kit));
  expect(kit.broadcast.created).toEqual([]);
  expect(
    await first(kit.env.DB, 'SELECT state, error_code FROM broadcasts WHERE id = ?', [
      scheduled.id,
    ]),
  ).toEqual({ state: 'cancelled', error_code: 'CREATOR_REVOKED' });
});
