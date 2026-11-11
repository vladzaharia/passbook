import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiKeyFixture,
  editApiKeyIdentity,
  editSessionAuthority,
  makeApiKey,
  makeOrg,
  makeSession,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores, type SessionAuth } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { setDeps } from './deps.ts';
import { closeRun } from './health.ts';
import { getConnection } from './repo.ts';
import { markPassSyncError, markPassSynced, type SyncSnapshot } from './repo-pass-snapshot.ts';
import { getPassById } from './repo-passes.ts';
import { insertRun } from './repo-runs.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import { readConnectorSecrets, readWebhookSecret } from './secrets.ts';
import * as service from './service.ts';
import { startRun } from './sync.ts';
import { executeSync } from './sync-runner.ts';
import { testConfig } from './test-config.ts';
import {
  addMembership,
  createDemo,
  demoInput,
  type Kit,
  linkedPass,
  makeKit,
  withWorkflow,
} from './test-kit.ts';

let kit: Kit;
let session: SessionAuth;
let membershipId: string;
let authority: ConnectionAuthority;
let credentialKeysetCommitment: string;

beforeEach(async () => {
  kit = await makeKit();
  credentialKeysetCommitment = kit.credentialKeysetCommitment;
  membershipId = await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const resolved = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!resolved) throw new Error('The persisted session did not resolve');
  session = resolved;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const revokeSession = () =>
  run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
    kit.clock.now(),
    session.sessionId,
  ]);
const revokeMembership = () =>
  run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
    kit.clock.now(),
    membershipId,
  ]);

const httpInput = (overrides: Parameters<typeof demoInput>[1] = {}) =>
  demoInput(kit, {
    connectorType: 'http-json',
    config: { baseUrl: 'https://api.example.com/v1' },
    secrets: { token: 'original-secret' },
    ...overrides,
  } as never);

interface DatabaseState {
  connections: unknown[];
  credentials: unknown[];
  runs: unknown[];
  workflows: unknown[];
  audits: unknown[];
}

/** Compare encrypted material as hex rather than adapter-specific D1 blob representations. */
async function state(): Promise<DatabaseState> {
  return {
    connections: await all(kit.env.DB, 'SELECT * FROM connections WHERE org_id = ? ORDER BY id', [
      kit.org.id,
    ]),
    credentials: await all(
      kit.env.DB,
      `SELECT id, org_id, kind, kek_version, hex(iv) AS iv,
      hex(wrapped_dek) AS wrapped_dek, hex(ciphertext) AS ciphertext, fingerprint, created_by, created_at
      FROM credentials WHERE org_id = ? ORDER BY id`,
      [kit.org.id],
    ),
    runs: await all(
      kit.env.DB,
      `SELECT r.* FROM connection_runs r JOIN connections c ON c.id = r.connection_id
      WHERE c.org_id = ? ORDER BY r.id`,
      [kit.org.id],
    ),
    workflows: await all(
      kit.env.DB,
      'SELECT * FROM workflow_runs WHERE org_id = ? ORDER BY instance_id',
      [kit.org.id],
    ),
    audits: await all(kit.env.DB, 'SELECT * FROM audit_log WHERE org_id = ? ORDER BY id', [
      kit.org.id,
    ]),
  };
}

/**
 * Intervene exactly once at a real D1 write, without replacing or simulating the database. Guarded
 * writes run as one grant batch, so a `batch` holding a matching statement counts as that write.
 */
function atWrite(
  sctx: ServiceContext,
  matches: (sql: string) => boolean,
  phase: 'before' | 'after',
  intervene: () => Promise<void>,
) {
  let hits = 0;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; target: D1PreparedStatement }
  >();
  const around = async <T>(selected: boolean, call: () => Promise<T>): Promise<T> => {
    if (selected) hits++;
    if (selected && phase === 'before') await intervene();
    const result = await call();
    if (selected && phase === 'after') await intervene();
    return result;
  };
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, prop) {
        const value = Reflect.get(statement, prop, statement);
        if (prop === 'bind') return (...args: unknown[]) => wrap(statement.bind(...args), sql);
        if (prop === 'run') {
          return (...args: unknown[]) =>
            around(hits === 0 && matches(sql), () =>
              (value as (...a: unknown[]) => Promise<unknown>).apply(statement, args),
            );
        }
        return typeof value === 'function' ? value.bind(statement) : value;
      },
    });
    statements.set(proxy, { sql, target });
    return proxy;
  };
  const db = new Proxy(sctx.env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch') {
        return (batch: D1PreparedStatement[]) =>
          around(
            hits === 0 && batch.some((statement) => matches(statements.get(statement)?.sql ?? '')),
            () =>
              target.batch(
                batch.map((statement) => statements.get(statement)?.target ?? statement),
              ),
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { sctx: { ...sctx, env: { ...sctx.env, DB: db } }, hits: () => hits };
}

/** Hook the enqueue's run insert (a grant batch), not the earlier credential-keyset initialization batch. */
function atBatch(sctx: ServiceContext, phase: 'before' | 'after', intervene: () => Promise<void>) {
  let hits = 0;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; target: D1PreparedStatement }
  >();
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(statement.bind(...args), sql);
        const value = Reflect.get(statement, prop, statement);
        return typeof value === 'function' ? value.bind(statement) : value;
      },
    });
    statements.set(proxy, { sql, target });
    return proxy;
  };
  const db = new Proxy(sctx.env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch') {
        return async (batch: D1PreparedStatement[]) => {
          const selected =
            hits === 0 &&
            batch.some((statement) =>
              [statements.get(statement)?.sql].some(
                (sql) =>
                  sql?.includes('INSERT INTO connection_runs') ||
                  sql?.includes('INSERT OR IGNORE INTO workflow_runs'),
              ),
            );
          if (selected) hits++;
          if (selected && phase === 'before') await intervene();
          const result = await target.batch(
            batch.map((statement) => statements.get(statement)?.target ?? statement),
          );
          if (selected && phase === 'after') await intervene();
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { sctx: { ...sctx, env: { ...sctx.env, DB: db } }, hits: () => hits };
}

const credentialInsert = (sql: string) => sql.includes('INSERT INTO credentials');
const connectionInsert = (sql: string) => sql.includes('INSERT INTO connections');
const connectionUpdate = (sql: string) => sql.startsWith('UPDATE connections SET');
const connectionDelete = (sql: string) => sql.startsWith('DELETE FROM connections WHERE');

// A key's scopes, org and mode are immutable (0039), so "scope removed" cannot happen mid-request.
type KeyInvalidation = 'revoked' | 'expired';
const keyInvalidations: KeyInvalidation[] = ['revoked', 'expired'];

async function invalidateKey(id: string, reason: KeyInvalidation): Promise<void> {
  // Expiry is time passing: rewriting expires_at to now reaches the same state as the clock moving.
  if (reason === 'expired')
    await editApiKeyIdentity(kit.env.DB, 'UPDATE api_keys SET expires_at = ? WHERE id = ?', [
      kit.clock.now(),
      id,
    ]);
  else
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [kit.clock.now(), id]);
}

/** Resolve the real persisted bearer key through the same scoped middleware as production. */
async function keyRequest(
  sctx: ServiceContext,
  key: ApiKeyFixture,
  method: string,
  path: string,
  body?: unknown,
) {
  const app = createApp({
    stores: { ...denyAllStores, apiKeys: createApiKeyStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const response = await app.request(
    path,
    {
      method,
      headers: {
        ...key.headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    sctx.env,
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe('persisted principal at the final connection write', () => {
  it('allows an active integration administrator and fences a real update', async () => {
    const connection = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, connection.id, { config: { count: 4 } }, authority);
    expect(await getConnection(kit.env.DB, connection.id)).toMatchObject({
      generation: 2,
      config: { count: 4 },
    });
  });

  it.each([
    [
      'the exact session is revoked',
      async () => {
        await revokeSession();
      },
    ],
    [
      'the session reaches its absolute expiry',
      async () => {
        await editSessionAuthority(
          kit.env.DB,
          'UPDATE sessions SET expires_at = ? WHERE id_hash = ?',
          [kit.clock.now(), session.sessionId],
        );
      },
    ],
    [
      'the session reaches its idle expiry',
      async () => {
        await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          session.sessionId,
        ]);
      },
    ],
    [
      'the membership is revoked',
      async () => {
        await revokeMembership();
      },
    ],
    [
      'the user is disabled',
      async () => {
        await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [kit.actor.id]);
      },
    ],
    [
      'the organization is suspended',
      async () => {
        await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      },
    ],
  ] as const)('does not update a connection after %s', async (_label, invalidate) => {
    const connection = await createDemo(kit);
    const before = await state();
    await invalidate();
    await expect(
      service.update(kit.sctx, kit.actor, connection.id, { config: { count: 4 } }, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });

  // Session roles are immutable (0047) and checked once in JS: the edit is refused, so they cannot be lost.
  it('cannot strip the session roles under a connection update', async () => {
    await expect(
      kit.env.DB.prepare("UPDATE sessions SET roles = '[]' WHERE id_hash = ?")
        .bind(session.sessionId)
        .run(),
    ).rejects.toThrow('session authority is immutable');
  });

  it('does not transfer a captured grant to a replacement membership', async () => {
    const connection = await createDemo(kit);
    const before = await state();
    await revokeMembership();
    await addMembership(kit, kit.actor.id, ['integration_admin']);
    await expect(
      service.update(kit.sctx, kit.actor, connection.id, { enabled: false }, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
    const replacementAuthority = await authorizeConnection(
      kit.sctx,
      session,
      kit.org.id,
      'integrations:manage',
    );
    await service.update(
      kit.sctx,
      kit.actor,
      connection.id,
      { enabled: false },
      replacementAuthority,
    );
    expect((await getConnection(kit.env.DB, connection.id))?.enabled).toBe(false);
  });

  it('does not promote a read-only membership snapshot to a management grant', async () => {
    const connection = await createDemo(kit);
    await revokeMembership();
    await addMembership(kit, kit.actor.id, ['read_only']);
    const readAuthority = await authorizeConnection(
      kit.sctx,
      session,
      kit.org.id,
      'integrations:read',
    );
    const before = await state();
    await expect(
      service.update(kit.sctx, kit.actor, connection.id, { enabled: false }, readAuthority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });

  it('does not transfer authority to another active session of the same user', async () => {
    const connection = await createDemo(kit);
    const before = await state();
    const replacement = await makeSession(kit, { userId: kit.actor.id });
    const replacementAuth = await createSessionStore(kit.env, kit.clock).resolve(
      replacement.cookieValue,
    );
    if (!replacementAuth) throw new Error('The replacement session did not resolve');
    const replacementAuthority = await authorizeConnection(
      kit.sctx,
      replacementAuth,
      kit.org.id,
      'integrations:manage',
    );
    await revokeSession();
    await expect(
      service.update(kit.sctx, kit.actor, connection.id, { enabled: false }, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
    await service.update(
      kit.sctx,
      kit.actor,
      connection.id,
      { enabled: false },
      replacementAuthority,
    );
    expect((await getConnection(kit.env.DB, connection.id))?.enabled).toBe(false);
  });

  it('rejects a Test-mode session snapshot at the live mutation boundary', async () => {
    const connection = await createDemo(kit);
    const testAuthority = await authorizeConnection(
      kit.sctx,
      { ...session, mode: 'test' },
      kit.org.id,
      'integrations:manage',
    );
    const before = await state();
    await expect(
      service.update(kit.sctx, kit.actor, connection.id, { enabled: false }, testAuthority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });

  it.each(['active', 'revoked', 'expired'] as const)(
    'does not accept a %s passes-only key as connection authority',
    async (status) => {
      const connection = await createDemo(kit);
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['passes:write'] });
      const store = createApiKeyStore(kit.env, kit.clock);
      const auth = await store.resolve(key.secret);
      if (!auth) throw new Error('The persisted key did not resolve');
      if (status !== 'active') {
        await invalidateKey(key.id, status);
        expect(await store.resolve(key.secret)).toBeNull();
      }
      const before = await state();
      for (const capability of ['integrations:read', 'integrations:manage'] as const) {
        await expect(
          authorizeConnection(kit.sctx, auth, kit.org.id, capability),
        ).rejects.toMatchObject({ status: 403, code: 'MISSING_SCOPE' });
      }
      expect(await state()).toEqual(before);
      expect((await getConnection(kit.env.DB, connection.id))?.generation).toBe(1);
    },
  );

  it('rejects an unauthenticated caller at the connection boundary', async () => {
    await expect(
      authorizeConnection(kit.sctx, undefined, kit.org.id, 'integrations:read'),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('API-key authority at the final D1 write', () => {
  it.each([
    ['read-only', ['connections:read']],
    ['read/write', ['connections:read', 'connections:write']],
  ] as const)(
    'cannot promote a real read grant from a %s key to a service write',
    async (_label, scopes) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: [...scopes] });
      const connection = await createDemo(kit);
      const before = await state();
      const authorities: ConnectionAuthority[] = [];
      const probe = new Hono<AppBindings>();
      probe.use(
        '*',
        requestContext({
          stores: { ...denyAllStores, apiKeys: createApiKeyStore(kit.env, kit.clock) },
          clock: kit.clock,
        }),
      );
      probe.use('*', requireTenantSessionOrApiKey('connections:read'));
      probe.get('/', async (c) => {
        authorities.push(
          await authorizeConnection(kit.sctx, c.var.auth, kit.org.id, 'integrations:read'),
        );
        return c.text('ok');
      });
      expect((await probe.request('/', { headers: key.headers }, kit.env)).status).toBe(200);
      const readAuthority = authorities[0];
      if (!readAuthority) throw new Error('The scoped middleware did not produce an authority');
      expect(readAuthority).toMatchObject({
        kind: 'api_key',
        orgId: kit.org.id,
        scope: 'connections:read',
      });
      await expect(
        service.update(
          kit.sctx,
          { type: 'api_key', id: key.id },
          connection.id,
          { enabled: false },
          readAuthority,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await state()).toEqual(before);
    },
  );

  it.each(keyInvalidations)(
    'cleans an encrypted credential if the key is %s before create commits',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const before = await state();
      const seam = atWrite(kit.sctx, credentialInsert, 'after', () =>
        invalidateKey(key.id, reason),
      );
      const response = await keyRequest(seam.sctx, key, 'POST', '/api/v1/connections', httpInput());
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );

  it('cleans the new credential when a key expires naturally before connection insertion', async () => {
    const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    await editApiKeyIdentity(kit.env.DB, 'UPDATE api_keys SET expires_at = ? WHERE id = ?', [
      kit.clock.now() + 1000,
      key.id,
    ]);
    const before = await state();
    const seam = atWrite(kit.sctx, credentialInsert, 'after', async () => {
      kit.clock.advance(1000);
    });
    const response = await keyRequest(seam.sctx, key, 'POST', '/api/v1/connections', httpInput());
    expect(response.status).toBe(403);
    expect(seam.hits()).toBe(1);
    expect(await state()).toEqual(before);
  });

  it.each(keyInvalidations)(
    'preserves the old secret if the key is %s before update commits',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await service.create(kit.sctx, kit.actor, httpInput());
      const before = await state();
      const seam = atWrite(kit.sctx, credentialInsert, 'after', () =>
        invalidateKey(key.id, reason),
      );
      const response = await keyRequest(
        seam.sctx,
        key,
        'PATCH',
        `/api/v1/connections/${connection.id}`,
        {
          secrets: { token: 'replacement-secret' },
        },
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
      const stored = await getConnection(kit.env.DB, connection.id);
      if (!stored) throw new Error('Missing connection');
      expect(stored.generation).toBe(1);
      expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({ token: 'original-secret' });
    },
  );

  it.each(keyInvalidations)(
    'preserves connection, credentials and pass if the key is %s before delete',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await service.create(kit.sctx, kit.actor, httpInput());
      const pass = await linkedPass(kit, connection.id, 'm-001');
      const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const before = await state();
      const seam = atWrite(kit.sctx, connectionDelete, 'before', () =>
        invalidateKey(key.id, reason),
      );
      const response = await keyRequest(
        seam.sctx,
        key,
        'DELETE',
        `/api/v1/connections/${connection.id}`,
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        passBefore,
      );
    },
  );

  it.each(keyInvalidations)(
    'does not rotate a webhook secret if the key is %s before update',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await createDemo(kit, {
        connectorType: 'webhook-push',
        config: {},
        mode: 'webhook',
      });
      const before = await state();
      const seam = atWrite(kit.sctx, credentialInsert, 'after', () =>
        invalidateKey(key.id, reason),
      );
      const response = await keyRequest(
        seam.sctx,
        key,
        'POST',
        `/api/v1/connections/${connection.id}/webhook-secret`,
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
      const stored = await getConnection(kit.env.DB, connection.id);
      if (!stored) throw new Error('Missing connection');
      expect(await readWebhookSecret(kit.sctx, stored)).toBe(connection.webhookSecret);
    },
  );

  it.each(keyInvalidations)(
    'writes no test run if the key is %s before the final write',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await createDemo(kit, { config: { count: 1 } });
      const before = await state();
      const seam = atWrite(
        kit.sctx,
        (sql) => sql.startsWith('INSERT INTO connection_runs'),
        'before',
        () => invalidateKey(key.id, reason),
      );
      const response = await keyRequest(
        seam.sctx,
        key,
        'POST',
        `/api/v1/connections/${connection.id}/test`,
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );

  it.each(keyInvalidations)(
    'does not audit or return an unsaved test if the key is %s before audit',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const before = await state();
      const seam = atWrite(
        kit.sctx,
        (sql) => sql.startsWith('INSERT INTO audit_log'),
        'before',
        () => invalidateKey(key.id, reason),
      );
      const response = await keyRequest(seam.sctx, key, 'POST', '/api/v1/connections/test-config', {
        orgId: kit.org.id,
        connectorType: 'demo',
        config: { count: 1 },
      });
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );

  it.each(['org_id', 'mode', 'scopes'] as const)(
    'cannot change a key %s under a captured grant: it is immutable',
    async (column) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const other = await makeOrg(kit);
      const value = { org_id: other.id, mode: 'test', scopes: '["connections:read"]' }[column];
      await expect(
        run(kit.env.DB, `UPDATE api_keys SET ${column} = ? WHERE id = ?`, [value, key.id]),
      ).rejects.toThrow(/immutable/);
    },
  );

  it('lets a valid null-org key update the named org, still bound by its scopes', async () => {
    const key = await makeApiKey(kit, { orgId: null, scopes: ['connections:write'] });
    const readOnly = await makeApiKey(kit, { orgId: null, scopes: ['connections:read'] });
    const connection = await createDemo(kit);
    const path = `/api/v1/connections/${connection.id}`;
    expect(
      (await keyRequest(kit.sctx, readOnly, 'PATCH', path, { config: { count: 4 } })).status,
    ).toBe(403);
    const response = await keyRequest(kit.sctx, key, 'PATCH', path, { config: { count: 4 } });
    expect(response.status).toBe(200);
    expect((await getConnection(kit.env.DB, connection.id))?.config).toMatchObject({ count: 4 });
  });

  it.each(keyInvalidations)(
    'fences a platform key that is %s before updating an explicitly named org',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: null, scopes: ['connections:write'] });
      const connection = await createDemo(kit);
      const before = await state();
      const seam = atWrite(kit.sctx, connectionUpdate, 'before', () =>
        invalidateKey(key.id, reason),
      );
      const response = await keyRequest(
        seam.sctx,
        key,
        'PATCH',
        `/api/v1/connections/${connection.id}`,
        {
          config: { count: 4 },
        },
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );
});

describe('revocation between asynchronous preparation and commit', () => {
  it('aborts create after session expiry during DNS validation', async () => {
    const before = await state();
    let resolved = 0;
    setDeps({
      resolver: {
        resolve: async () => {
          resolved++;
          await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
            kit.clock.now(),
            session.sessionId,
          ]);
          return ['93.184.216.34'];
        },
      },
    });
    await expect(
      service.create(kit.sctx, kit.actor, httpInput(), authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(resolved).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
  });

  it('cleans the newly encrypted credential when membership is revoked before connection INSERT', async () => {
    const before = await state();
    const seam = atWrite(kit.sctx, credentialInsert, 'after', async () => {
      await revokeMembership();
    });
    await expect(
      service.create(seam.sctx, kit.actor, httpInput(), authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seam.hits()).toBe(1);
    expect(await state()).toEqual(before);
  });

  it('cleans a replacement secret and preserves the old one when session revocation wins UPDATE', async () => {
    const connection = await service.create(kit.sctx, kit.actor, httpInput());
    const before = await state();
    const seam = atWrite(kit.sctx, credentialInsert, 'after', async () => {
      await revokeSession();
    });
    await expect(
      service.update(
        seam.sctx,
        kit.actor,
        connection.id,
        {
          secrets: { token: 'replacement-secret' },
        },
        authority,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seam.hits()).toBe(1);
    expect(await state()).toEqual(before);
    const stored = await getConnection(kit.env.DB, connection.id);
    if (!stored) throw new Error('Missing connection');
    expect(stored.generation).toBe(1);
    expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({ token: 'original-secret' });
  });

  it('does not replace credentials if the connection generation changes before UPDATE', async () => {
    const connection = await service.create(kit.sctx, kit.actor, httpInput());
    const before = await state();
    const seam = atWrite(kit.sctx, connectionUpdate, 'before', async () => {
      await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
        connection.id,
      ]);
    });
    await expect(
      service.update(
        seam.sctx,
        kit.actor,
        connection.id,
        {
          secrets: { token: 'replacement-secret' },
        },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    expect(seam.hits()).toBe(1);
    const stored = await getConnection(kit.env.DB, connection.id);
    if (!stored) throw new Error('Missing connection');
    expect(stored.generation).toBe(2);
    expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({ token: 'original-secret' });
    const after = await state();
    expect(after.credentials).toEqual(before.credentials);
    expect(after.audits).toEqual(before.audits);
  });

  it('cannot delete a connection, its credentials or its linked pass after membership revocation', async () => {
    const connection = await service.create(kit.sctx, kit.actor, httpInput());
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const passBefore = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const before = await state();
    const seam = atWrite(kit.sctx, connectionDelete, 'before', async () => {
      await revokeMembership();
    });
    await expect(
      service.remove(seam.sctx, kit.actor, connection.id, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seam.hits()).toBe(1);
    expect(await state()).toEqual(before);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      passBefore,
    );
  });

  it('cleans a new webhook secret and preserves the old one when revocation wins rotation', async () => {
    const connection = await createDemo(kit, {
      connectorType: 'webhook-push',
      config: {},
      mode: 'webhook',
    });
    const before = await state();
    const seam = atWrite(kit.sctx, credentialInsert, 'after', async () => {
      await revokeMembership();
    });
    await expect(
      actions.rotateWebhookSecret(seam.sctx, kit.actor, connection.id, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seam.hits()).toBe(1);
    expect(await state()).toEqual(before);
    const stored = await getConnection(kit.env.DB, connection.id);
    if (!stored) throw new Error('Missing connection');
    expect(stored.generation).toBe(1);
    expect(await readWebhookSecret(kit.sctx, stored)).toBe(connection.webhookSecret);
  });

  it('does not complete a test run when the session is revoked during connector I/O', async () => {
    const connection = await service.create(
      kit.sctx,
      kit.actor,
      httpInput({
        config: {
          baseUrl: 'https://api.example.com/v1',
          testRef: 'm-1',
          recordPath: '/members/{ref}',
        },
      }),
    );
    const before = await state();
    let requests = 0;
    setDeps({
      fetchImpl: async () => {
        if (requests++ === 0) await revokeSession();
        return new Response(JSON.stringify({ memberName: 'Maya' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await expect(
      actions.test(kit.sctx, kit.actor, connection.id, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(requests).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
  });

  it('does not audit or return an unsaved test after membership is revoked during I/O', async () => {
    const before = await state();
    let requests = 0;
    setDeps({
      fetchImpl: async () => {
        if (requests++ === 0) await revokeMembership();
        return new Response(JSON.stringify({ memberName: 'Maya' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await expect(
      testConfig(
        kit.sctx,
        kit.actor,
        {
          orgId: kit.org.id,
          connectorType: 'http-json',
          config: {
            baseUrl: 'https://api.example.com/v1',
            testRef: 'm-1',
            recordPath: '/members/{ref}',
          },
          secrets: { token: 'original-secret' },
        },
        authority,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(requests).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
  });
});

describe('ambiguous D1 writes and credential cleanup', () => {
  it.each(['before', 'after'] as const)(
    'cleans an unreferenced credential if its insert fails %s commit',
    async (phase) => {
      const before = await state();
      const seam = atWrite(kit.sctx, credentialInsert, phase, async () => {
        throw new Error('uncertain credential write');
      });
      await expect(service.create(seam.sctx, kit.actor, httpInput(), authority)).rejects.toThrow(
        'uncertain credential write',
      );
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );

  it.each(['before', 'after'] as const)(
    'cleans both new secrets when the second insert fails %s commit',
    async (phase) => {
      const before = await state();
      let credentialWrites = 0;
      const seam = atWrite(
        kit.sctx,
        (sql) => credentialInsert(sql) && ++credentialWrites === 2,
        phase,
        async () => {
          throw new Error('uncertain second credential');
        },
      );
      await expect(
        service.create(seam.sctx, kit.actor, httpInput({ mode: 'hybrid' }), authority),
      ).rejects.toThrow('uncertain second credential');
      expect(credentialWrites).toBe(2);
      expect(seam.hits()).toBe(1);
      expect(await state()).toEqual(before);
    },
  );

  it('does not discard an ambiguously inserted credential that has become referenced', async () => {
    const connection = await service.create(kit.sctx, kit.actor, httpInput({ secrets: {} }));
    let credentialId: string | undefined;
    const seam = atWrite(kit.sctx, credentialInsert, 'after', async () => {
      const credential = await first<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM credentials WHERE org_id = ?',
        [kit.org.id],
      );
      if (!credential) throw new Error('Missing inserted credential');
      credentialId = credential.id;
      await run(kit.env.DB, 'UPDATE connections SET credential_id = ? WHERE id = ?', [
        credential.id,
        connection.id,
      ]);
      throw new Error('uncertain credential write');
    });
    await expect(service.create(seam.sctx, kit.actor, httpInput(), authority)).rejects.toThrow(
      'uncertain credential write',
    );
    expect(seam.hits()).toBe(1);
    const stored = await getConnection(kit.env.DB, connection.id);
    if (!stored || !credentialId) throw new Error('The referenced credential was lost');
    expect(stored.credentialId).toBe(credentialId);
    expect(
      await first(kit.env.DB, 'SELECT id FROM credentials WHERE id = ?', [credentialId]),
    ).not.toBeNull();
    expect((await state()).credentials).toHaveLength(1);
    expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({ token: 'original-secret' });
  });

  it.each(['before', 'after'] as const)(
    'preserves only referenced credentials when connection INSERT fails %s commit',
    async (phase) => {
      const before = await state();
      const seam = atWrite(kit.sctx, connectionInsert, phase, async () => {
        throw new Error('uncertain connection insert');
      });
      await expect(service.create(seam.sctx, kit.actor, httpInput(), authority)).rejects.toThrow(
        'uncertain connection insert',
      );
      expect(seam.hits()).toBe(1);
      const after = await state();
      if (phase === 'before') {
        expect(after).toEqual(before);
      } else {
        const row = await first<{ id: string; credential_id: string }>(
          kit.env.DB,
          'SELECT id, credential_id FROM connections WHERE org_id = ?',
          [kit.org.id],
        );
        if (!row) throw new Error('Committed connection missing');
        expect(after.credentials).toHaveLength(1);
        expect(after.credentials[0]).toMatchObject({ id: row.credential_id });
        const stored = await getConnection(kit.env.DB, row.id);
        if (!stored) throw new Error('Committed connection missing');
        expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({ token: 'original-secret' });
      }
    },
  );

  it.each(['before', 'after'] as const)(
    'preserves the referenced credential when connection UPDATE fails %s commit',
    async (phase) => {
      const connection = await service.create(kit.sctx, kit.actor, httpInput());
      const before = await state();
      const seam = atWrite(kit.sctx, connectionUpdate, phase, async () => {
        throw new Error('uncertain connection update');
      });
      await expect(
        service.update(
          seam.sctx,
          kit.actor,
          connection.id,
          { secrets: { token: 'replacement-secret' } },
          authority,
        ),
      ).rejects.toThrow('uncertain connection update');
      expect(seam.hits()).toBe(1);
      const after = await state();
      const stored = await getConnection(kit.env.DB, connection.id);
      if (!stored) throw new Error('Missing connection');
      expect(after.credentials).toHaveLength(1);
      expect(after.credentials[0]).toMatchObject({ id: stored.credentialId });
      expect(await readConnectorSecrets(kit.sctx, stored)).toEqual({
        token: phase === 'before' ? 'original-secret' : 'replacement-secret',
      });
      expect(stored.generation).toBe(phase === 'before' ? 1 : 2);
      if (phase === 'before') expect(after).toEqual(before);
    },
  );

  it.each(['before', 'after'] as const)(
    'keeps the referenced webhook secret when rotation fails %s commit',
    async (phase) => {
      const connection = await createDemo(kit, {
        connectorType: 'webhook-push',
        config: {},
        mode: 'webhook',
      });
      const before = await state();
      const seam = atWrite(kit.sctx, connectionUpdate, phase, async () => {
        throw new Error('uncertain rotation');
      });
      await expect(
        actions.rotateWebhookSecret(seam.sctx, kit.actor, connection.id, authority),
      ).rejects.toThrow('uncertain rotation');
      expect(seam.hits()).toBe(1);
      const after = await state();
      const stored = await getConnection(kit.env.DB, connection.id);
      if (!stored) throw new Error('Missing connection');
      expect(after.credentials).toHaveLength(1);
      expect(after.credentials[0]).toMatchObject({ id: stored.webhookCredentialId });
      expect(stored.generation).toBe(phase === 'before' ? 1 : 2);
      const secret = await readWebhookSecret(kit.sctx, stored);
      if (phase === 'before') {
        expect(secret).toBe(connection.webhookSecret);
        expect(after).toEqual(before);
      } else {
        expect(secret).toMatch(/^whsec_/);
        expect(secret).not.toBe(connection.webhookSecret);
      }
    },
  );

  it.each(['before', 'after'] as const)(
    'cleans only unreferenced credentials when connection DELETE fails %s commit',
    async (phase) => {
      const connection = await service.create(kit.sctx, kit.actor, httpInput());
      const before = await state();
      const seam = atWrite(kit.sctx, connectionDelete, phase, async () => {
        throw new Error('uncertain connection delete');
      });
      await expect(service.remove(seam.sctx, kit.actor, connection.id, authority)).rejects.toThrow(
        'uncertain connection delete',
      );
      expect(seam.hits()).toBe(1);
      const after = await state();
      if (phase === 'before') {
        expect(after).toEqual(before);
      } else {
        expect(after.connections).toEqual([]);
        expect(after.credentials).toEqual([]);
      }
    },
  );
});

describe('manual workflow enqueue authority', () => {
  it.each(keyInvalidations)(
    'does not enqueue if the key is %s before the atomic batch',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await createDemo(kit);
      const workflow = withWorkflow(kit);
      const before = await state();
      const seam = atBatch(workflow.sctx, 'before', () => invalidateKey(key.id, reason));
      const response = await keyRequest(
        seam.sctx,
        key,
        'POST',
        `/api/v1/connections/${connection.id}/sync`,
      );
      expect(response.status).toBe(403);
      expect(seam.hits()).toBe(1);
      expect(workflow.created).toEqual([]);
      expect(await state()).toEqual(before);
    },
  );

  it.each(keyInvalidations)(
    'runs an authorized enqueue as the connection when the key is %s after commit',
    async (reason) => {
      const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const connection = await createDemo(kit, { config: { count: 1 } });
      await linkedPass(kit, connection.id, 'm-001');
      const workflow = withWorkflow(kit);
      const seam = atBatch(workflow.sctx, 'after', () => invalidateKey(key.id, reason));
      const response = await keyRequest(
        seam.sctx,
        key,
        'POST',
        `/api/v1/connections/${connection.id}/sync`,
      );
      expect(response.status).toBe(202);
      expect(seam.hits()).toBe(1);
      expect(workflow.created).toEqual([
        {
          id: response.json.workflowInstanceId,
          params: {
            connectionId: connection.id,
            orgId: kit.org.id,
            generation: 1,
            credentialKeysetCommitment,
            trigger: 'admin',
            runId: response.json.runId,
          },
        },
      ]);
      expect(JSON.stringify(workflow.created)).not.toContain(key.secret);
      expect(JSON.stringify(workflow.created)).not.toContain(key.id);
      await executeSync(workflow.sctx, inlineStep(), {
        connectionId: connection.id,
        orgId: kit.org.id,
        generation: 1,
        credentialKeysetCommitment,
        trigger: 'admin',
        runId: response.json.runId as string,
        instanceId: response.json.workflowInstanceId as string,
      });
      expect(kit.seams.applied).toHaveLength(1);
      expect(
        await first(kit.env.DB, 'SELECT outcome FROM connection_runs WHERE id = ?', [
          response.json.runId,
        ]),
      ).toMatchObject({ outcome: 'changed' });
    },
  );

  it('does not launch or insert tracking rows if membership is revoked before enqueue', async () => {
    const connection = await createDemo(kit);
    const workflow = withWorkflow(kit);
    const before = await state();
    const seam = atBatch(workflow.sctx, 'before', async () => {
      await revokeMembership();
    });
    await expect(
      actions.syncNow(seam.sctx, kit.actor, connection.id, authority),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seam.hits()).toBe(1);
    expect(workflow.created).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it('preserves a committed same-bucket enqueue when a competing session is revoked', async () => {
    const connection = await createDemo(kit);
    const workflow = withWorkflow(kit);
    const otherFixture = await makeSession(kit, { userId: kit.actor.id });
    const otherSession = await createSessionStore(kit.env, kit.clock).resolve(
      otherFixture.cookieValue,
    );
    if (!otherSession) throw new Error('The second session did not resolve');
    const otherAuthority = await authorizeConnection(
      kit.sctx,
      otherSession,
      kit.org.id,
      'integrations:manage',
    );
    const committed: DatabaseState[] = [];
    const first = atBatch(workflow.sctx, 'after', async () => {
      // A has committed the tracking pair in one grant batch, but has not invoked the workflow binding.
      const snapshot = await state();
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.workflows).toHaveLength(1);
      const competing = atBatch(workflow.sctx, 'before', async () => {
        await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          otherSession.sessionId,
        ]);
      });
      await expect(
        actions.syncNow(competing.sctx, kit.actor, connection.id, otherAuthority),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(competing.hits()).toBe(1);
      expect(workflow.created).toEqual([]);
      expect(await state()).toEqual(snapshot);
      committed.push(snapshot);
    });
    const started = await actions.syncNow(first.sctx, kit.actor, connection.id, authority);
    expect(first.hits()).toBe(1);
    expect(workflow.created).toHaveLength(1);
    expect(workflow.created[0]?.id).toBe(started.workflowInstanceId);
    const snapshot = committed[0];
    if (!snapshot) throw new Error('The first request did not commit');
    const after = await state();
    expect(after.runs).toEqual(snapshot.runs);
    expect(after.workflows).toEqual(snapshot.workflows);
  });

  it('does not launch a stale generation or leave tracking rows behind', async () => {
    const connection = await createDemo(kit);
    const workflow = withWorkflow(kit);
    const before = await state();
    const seam = atBatch(workflow.sctx, 'before', async () => {
      await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
        connection.id,
      ]);
    });
    await expect(
      actions.syncNow(seam.sctx, kit.actor, connection.id, authority),
    ).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    expect(seam.hits()).toBe(1);
    expect(workflow.created).toEqual([]);
    expect((await getConnection(kit.env.DB, connection.id))?.generation).toBe(2);
    const after = await state();
    expect(after.runs).toEqual(before.runs);
    expect(after.workflows).toEqual(before.workflows);
    expect(after.audits).toEqual(before.audits);
  });

  it('retains a committed enqueue for an idempotent same-bucket retry if launch fails', async () => {
    const connection = await createDemo(kit);
    let attempts = 0;
    const workflow = withWorkflow(kit, async () => {
      if (++attempts === 1) throw new Error('workflow unavailable');
    });
    await expect(
      actions.syncNow(workflow.sctx, kit.actor, connection.id, authority),
    ).rejects.toThrow('workflow unavailable');
    const committed = await state();
    expect(committed.runs).toHaveLength(1);
    expect(committed.workflows).toHaveLength(1);
    expect(committed.runs[0]).toMatchObject({ outcome: 'running' });
    expect(committed.workflows[0]).toMatchObject({ status: 'queued' });
    expect(workflow.created).toEqual([]);

    const retried = await actions.syncNow(workflow.sctx, kit.actor, connection.id, authority);
    expect(attempts).toBe(2);
    expect(workflow.created).toHaveLength(1);
    expect(workflow.created[0]?.id).toBe(retried.workflowInstanceId);
    const after = await state();
    expect(after.runs).toEqual(committed.runs);
    expect(after.workflows).toEqual(committed.workflows);
  });

  it('launches and runs as the connection when the session is revoked after enqueue commit', async () => {
    const connection = await createDemo(kit, { config: { count: 1 } });
    await linkedPass(kit, connection.id, 'm-001');
    const workflow = withWorkflow(kit);
    const seam = atBatch(workflow.sctx, 'after', async () => {
      await revokeSession();
    });
    const started = await actions.syncNow(seam.sctx, kit.actor, connection.id, authority);
    expect(seam.hits()).toBe(1);
    expect(workflow.created).toEqual([
      {
        id: started.workflowInstanceId,
        params: {
          connectionId: connection.id,
          orgId: kit.org.id,
          generation: 1,
          credentialKeysetCommitment,
          trigger: 'admin',
          runId: started.runId,
        },
      },
    ]);
    await executeSync(workflow.sctx, inlineStep(), {
      connectionId: connection.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment,
      trigger: 'admin',
      runId: started.runId,
      instanceId: started.workflowInstanceId,
    });
    expect(kit.seams.applied).toHaveLength(1);
    expect(
      await first(kit.env.DB, 'SELECT outcome FROM connection_runs WHERE id = ?', [started.runId]),
    ).toMatchObject({ outcome: 'changed' });
  });
});

describe('sync bookkeeping guards', () => {
  it.each([
    ['a forged Test snapshot', null, false, { mode: 'test' }],
    [
      'a forged voided snapshot',
      "UPDATE passes SET status = 'voided' WHERE id = ?",
      false,
      { status: 'voided' },
    ],
    [
      'a changed connection generation',
      'UPDATE connections SET generation = generation + 1 WHERE id = ?',
      true,
      {},
    ],
    ['a disabled connection', 'UPDATE connections SET enabled = 0 WHERE id = ?', true, {}],
  ] as const)(
    'does not stamp success or error for %s',
    async (_label, sql, isConnection, forged) => {
      const connection = await createDemo(kit);
      const pass = await linkedPass(
        kit,
        connection.id,
        'm-001',
        kit.org.id,
        _label === 'a forged Test snapshot' ? 'test' : 'live',
      );
      const stored = await getPassById(kit.env.DB, pass.id);
      if (!stored) throw new Error('Missing pass');
      const snapshot: SyncSnapshot = {
        passId: stored.id,
        orgId: stored.orgId,
        identityId: stored.identityId,
        mode: 'live',
        status: 'active',
        expectedVersion: stored.version,
        expectedRowVersion: stored.rowVersion,
        ownerUserId: stored.ownerUserId,
        linkGeneration: stored.linkGeneration,
        credentialGeneration: stored.credentialGeneration,
        lifecycleGeneration: stored.lifecycleGeneration,
        credentialKeysetCommitment: stored.credentialKeysetCommitment,
        transferPending: stored.transferPending,
        connectionId: connection.id,
        externalRef: 'm-001',
        generation: 1,
        expectedConnectionMode: 'poll',
      };
      if (sql) await run(kit.env.DB, sql, [isConnection ? connection.id : pass.id]);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      // Deliberately violate the static snapshot type: SQL must independently require Live/active.
      const attempted = { ...snapshot, ...forged } as SyncSnapshot;
      expect(
        await markPassSynced(kit.sctx, { ...attempted, now: kit.clock.now(), nextSyncAt: null }),
      ).toBe(false);
      expect(
        await markPassSyncError(kit.sctx, {
          ...attempted,
          code: 'AUTH',
          nextSyncAt: kit.clock.now(),
        }),
      ).toBe(false);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
    },
  );

  it('stamps an active Live snapshot at the current generation', async () => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing pass');
    expect(
      await markPassSynced(kit.sctx, {
        passId: stored.id,
        orgId: stored.orgId,
        identityId: stored.identityId,
        mode: 'live',
        status: 'active',
        expectedVersion: stored.version,
        expectedRowVersion: stored.rowVersion,
        ownerUserId: stored.ownerUserId,
        linkGeneration: stored.linkGeneration,
        credentialGeneration: stored.credentialGeneration,
        lifecycleGeneration: stored.lifecycleGeneration,
        credentialKeysetCommitment: stored.credentialKeysetCommitment,
        transferPending: stored.transferPending,
        connectionId: connection.id,
        externalRef: 'm-001',
        generation: 1,
        expectedConnectionMode: 'poll',
        now: kit.clock.now(),
        nextSyncAt: null,
      }),
    ).toBe(true);
  });

  it('starts only the tracked workflow with the original keyset proof', async () => {
    const connection = await createDemo(kit);
    const params = {
      connectionId: connection.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule' as const,
      runId: 'start-proof',
      instanceId: 'start-proof',
      credentialKeysetCommitment,
    };
    await seedConnectionWorkflow(kit.sctx, params);
    const before = await state();
    const different =
      credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    for (const invalid of [
      { ...params, credentialKeysetCommitment: undefined },
      { ...params, credentialKeysetCommitment: different },
      { ...params, instanceId: 'another-instance' },
    ]) {
      expect(await startRun(kit.sctx, invalid as never)).toMatchObject({
        ok: false,
        reason: 'STALE_CONTEXT',
      });
      expect(await state()).toEqual(before);
    }
    expect(await startRun(kit.sctx, params)).toMatchObject({
      ok: true,
      mode: 'poll',
      credentialKeysetCommitment,
    });
  });

  it('does not finish a webhook run or update health with missing or changed proof', async () => {
    const connection = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
    });
    const runId = kit.ids.id();
    expect(
      await insertRun(
        kit.sctx,
        {
          id: runId,
          connectionId: connection.id,
          trigger: 'webhook',
          startedAt: kit.clock.now(),
          expected: { orgId: kit.org.id, generation: 1, credentialKeysetCommitment },
        },
        { orgId: kit.org.id },
      ),
    ).toBe(true);
    const outcome = {
      source: 'webhook' as const,
      runId,
      instanceId: null,
      orgId: kit.org.id,
      generation: 1,
      connectionMode: 'hybrid' as const,
      credentialKeysetCommitment,
      totals: { seen: 1, changed: 1, created: 0, missing: 0, errors: 0 },
      failure: null,
      stale: false,
      startedAt: kit.clock.now(),
    };
    const before = await state();
    const different =
      credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    for (const invalid of [
      { ...outcome, credentialKeysetCommitment: undefined },
      { ...outcome, credentialKeysetCommitment: different },
      { ...outcome, source: undefined },
    ]) {
      expect(
        await closeRun(kit.sctx, connection.id, invalid as never, { countsForBreaker: true }),
      ).toBe(true);
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    ['generation', 'success'],
    ['generation', 'failure'],
    ['generation', 'blocked'],
    ['mode', 'success'],
    ['mode', 'failure'],
    ['mode', 'blocked'],
  ] as const)(
    'corrects %s races during a %s health update to a stale run',
    async (change, result) => {
      const connection = await createDemo(kit);
      const runId = kit.ids.id();
      await seedConnectionWorkflow(kit.sctx, {
        connectionId: connection.id,
        orgId: kit.org.id,
        generation: 1,
        trigger: 'schedule',
        runId,
        instanceId: runId,
        credentialKeysetCommitment,
      });
      const healthSql = `SELECT health, consecutive_failures, breaker_open_until, cursor, next_run_at,
      last_run_at, last_success_at, last_error_code, last_error_at, updated_at
      FROM connections WHERE id = ?`;
      const before = await first(kit.env.DB, healthSql, [connection.id]);
      const seam = atWrite(kit.sctx, connectionUpdate, 'before', async () => {
        await run(
          kit.env.DB,
          change === 'generation'
            ? 'UPDATE connections SET generation = generation + 1 WHERE id = ?'
            : "UPDATE connections SET mode = 'manual' WHERE id = ?",
          [connection.id],
        );
      });
      const stale = await closeRun(
        seam.sctx,
        connection.id,
        {
          runId,
          source: 'workflow',
          instanceId: runId,
          orgId: kit.org.id,
          generation: 1,
          credentialKeysetCommitment,
          connectionMode: 'poll',
          totals: { seen: 1, changed: 0, created: 0, missing: 0, errors: 0 },
          failure:
            result === 'failure' ? { code: 'UPSTREAM', httpStatus: 503, retryAfterMs: null } : null,
          ...(result === 'blocked' ? { releaseBlocked: 'TEMPLATE_RELEASE_REQUIRED' as const } : {}),
          stale: false,
          startedAt: kit.clock.now(),
          errorDetail: result === 'failure' ? 'sensitive detail' : null,
        },
        { countsForBreaker: true },
      );
      expect(seam.hits()).toBe(1);
      expect(stale).toBe(true);
      expect(await first(kit.env.DB, healthSql, [connection.id])).toEqual(before);
      expect(
        await first(
          kit.env.DB,
          'SELECT outcome, error_code, error_detail, http_status FROM connection_runs WHERE id = ?',
          [runId],
        ),
      ).toEqual({
        outcome: 'skipped',
        error_code: 'STALE_CONTEXT',
        error_detail: null,
        http_status: null,
      });
    },
  );
});
