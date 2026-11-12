import { beforeAll, describe, expect, it } from 'vitest';
import {
  editApiKeyIdentity,
  makeApiKey,
  makeOrg,
  makePass,
} from '../../../../test/helpers/index.ts';
import { PassDevicesSchema, PassEventListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import type { AuthStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { recordPassEvent } from './record.ts';
import { eventMember, eventStores } from './test-auth-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let otherOrg: { id: string };
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  otherOrg = await makeOrg(kit.fx, { name: 'Other tenant' });
  app = createApp({ stores: eventStores(kit), clock: kit.clock });
}, 60_000);

const path = (pass: Pick<Pass, 'id'>, resource: 'events' | 'devices') =>
  `${ORIGIN}/api/v1/passes/${pass.id}/${resource}`;

type Interruption = 'authority' | 'pass-read' | 'pass-cas';

/** Interleave an actual D1 change at the authorization/read/commit boundary. */
async function withInterruption<T>(
  boundary: Interruption,
  change: (db: D1Database) => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let passReads = 0;
  let intercepted = 0;
  const isCas = (sql: string) =>
    /^\s*UPDATE\s+passes\s+SET\b/i.test(sql) && /RETURNING\s+version/i.test(sql);
  const before = async (sql: string) => {
    if (boundary === 'pass-cas' && intercepted === 0 && isCas(sql)) {
      intercepted++;
      await change(real);
    }
  };
  const after = async (sql: string) => {
    if (intercepted) return;
    const authority = boundary === 'authority' && /SELECT\s+1\s+AS\s+ok\s+WHERE/i.test(sql);
    const passRead =
      boundary === 'pass-read' && /AS\s+org_slug\s+FROM\s+passes\s+WHERE\s+id\s*=/i.test(sql);
    if (passRead) passReads++;
    if (authority || (passRead && passReads === 2)) {
      intercepted++;
      await change(real);
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await before(sql);
            const result = column === undefined ? await target.first() : await target.first(column);
            await after(sql);
            return result;
          };
        if (prop === 'run')
          return async () => {
            await before(sql);
            return target.run();
          };
        if (prop === 'all')
          return async () => {
            await before(sql);
            return target.all();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native: statement });
    return wrapped;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          for (const statement of batch) await before(statements.get(statement)?.sql ?? '');
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const result = await operation();
    expect(intercepted, `reached ${boundary}`).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

async function effects(passId: string) {
  return {
    pass: await first(
      kit.env.DB,
      'SELECT version, personalization, object_key FROM passes WHERE id = ?',
      [passId],
    ),
    versions: await all(
      kit.env.DB,
      'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [passId],
    ),
    events: await all(kit.env.DB, 'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id', [
      passId,
    ]),
    outbox: await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [passId]),
    audit: await all(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE target_type = 'pass' AND target_id = ? ORDER BY id",
      [passId],
    ),
  };
}

describe('pass event and device tenant races', () => {
  it.each([
    ['events', 'session'],
    ['events', 'membership'],
    ['events', 'api key'],
    ['devices', 'session'],
    ['devices', 'membership'],
    ['devices', 'api key'],
  ] as const)(
    'rejects %s after stale %s authority is authenticated',
    async (resource, invalidation) => {
      const pass = await kit.pass();
      const member = await eventMember(kit, kit.org.id);
      const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
      const real = eventStores(kit);
      let changed = false;
      const stores: AuthStores = {
        ...real,
        sessions: {
          async resolve(cookie) {
            const auth = await real.sessions.resolve(cookie);
            if (auth && !changed && invalidation !== 'api key') {
              changed = true;
              if (invalidation === 'membership')
                await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                  kit.clock.now(),
                  member.membership,
                ]);
              else
                await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                  kit.clock.now(),
                  await sha256Hex(member.session.cookieValue),
                ]);
            }
            return auth;
          },
        },
        apiKeys: {
          async resolve(secret) {
            const auth = await real.apiKeys.resolve(secret);
            if (auth && !changed && invalidation === 'api key') {
              changed = true;
              await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                key.id,
              ]);
            }
            return auth;
          },
        },
      };
      const racing = createApp({ stores, clock: kit.clock });
      const headers = invalidation === 'api key' ? key.headers : member.session.headers;
      const response = await racing.request(path(pass, resource), { headers }, kit.env);
      expect(changed).toBe(true);
      expect(response.status).toBe(404);
    },
    60_000,
  );

  it.each(['events', 'devices'] as const)(
    'does not disclose %s for a pass belonging to another org',
    async (resource) => {
      const pass = await makePass(kit.fx, { orgId: otherOrg.id, template: kit.template });
      const foreignPass = await getPass(kit.env.DB, pass.id);
      if (!foreignPass) throw new Error('Foreign pass fixture was not created');
      await kit.device(foreignPass, 'foreign-device', 'a'.repeat(64));
      await recordPassEvent(kit.ctx, {
        orgId: otherOrg.id,
        passId: pass.id,
        mode: 'live',
        kind: 'device.registered',
        device: 'foreign-device',
      });
      const foreignMember = await eventMember(kit, otherOrg.id);
      const ownResponse = await app.request(
        path(pass, resource),
        { headers: foreignMember.session.headers },
        kit.env,
      );
      expect(ownResponse.status).toBe(200);
      const ownBody = await ownResponse.json();
      if (resource === 'events')
        expect(PassEventListSchema.parse(ownBody).items.length).toBeGreaterThan(0);
      else expect(PassDevicesSchema.parse(ownBody).devices.length).toBeGreaterThan(0);
      const member = await eventMember(kit, kit.org.id);
      const response = await app.request(
        path(pass, resource),
        { headers: member.session.headers },
        kit.env,
      );
      expect(response.status).toBe(404);
    },
    60_000,
  );

  it.each([
    ['events', 'organization'],
    ['events', 'mode'],
    ['devices', 'organization'],
    ['devices', 'mode'],
  ] as const)(
    'preserves %s when an unreserved pass %s change is rejected after the service read',
    async (resource, change) => {
      const pass = await kit.pass();
      const key = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] });
      await kit.device(pass, 'race-device', 'a'.repeat(64));
      await recordPassEvent(kit.ctx, {
        orgId: kit.org.id,
        passId: pass.id,
        mode: 'live',
        kind: 'device.registered',
        device: 'race-device',
      });
      const before = await app.request(path(pass, resource), { headers: key.headers }, kit.env);
      expect(before.status).toBe(200);
      const beforeBody = await before.json();
      if (resource === 'events')
        expect(PassEventListSchema.parse(beforeBody).items.length).toBeGreaterThan(0);
      else expect(PassDevicesSchema.parse(beforeBody).devices.length).toBeGreaterThan(0);
      const response = await withInterruption(
        'pass-read',
        async (db) => {
          if (change === 'organization')
            await expect(
              run(db, 'UPDATE passes SET org_id = ? WHERE id = ?', [otherOrg.id, pass.id]),
            ).rejects.toThrow();
          else
            await expect(
              run(db, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]),
            ).rejects.toThrow();
        },
        async () => app.request(path(pass, resource), { headers: key.headers }, kit.env),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      if (resource === 'events')
        expect(PassEventListSchema.parse(body).items).toEqual(
          PassEventListSchema.parse(beforeBody).items,
        );
      else
        expect(PassDevicesSchema.parse(body).devices).toEqual(
          PassDevicesSchema.parse(beforeBody).devices,
        );
    },
    60_000,
  );

  it('preserves the removal version when an unreserved org change is rejected', async () => {
    const pass = await kit.pass();
    const key = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] });
    await kit.device(pass, 'removal-race-device', 'a'.repeat(64));
    await removePass(jobCtxOf(kit), { type: 'system', id: null }, pass.id, {}, null);
    const before = await app.request(path(pass, 'devices'), { headers: key.headers }, kit.env);
    const beforeBody = PassDevicesSchema.parse(await before.json());
    expect(beforeBody.removal?.version).toBe(2);
    const response = await withInterruption(
      'pass-read',
      async (db) => {
        await expect(
          run(db, 'UPDATE passes SET org_id = ? WHERE id = ?', [otherOrg.id, pass.id]),
        ).rejects.toThrow();
      },
      async () => app.request(path(pass, 'devices'), { headers: key.headers }, kit.env),
    );
    expect(response.status).toBe(200);
    const body = PassDevicesSchema.parse(await response.json());
    // A removed pass keeps listing its registered devices until the removal reaches them.
    expect(body.devices).toEqual(beforeBody.devices);
    expect(body.removal?.version).toBe(2);
  }, 60_000);
});

describe('pass event side effects', () => {
  it.each(['session', 'membership', 'api key', 'key scope', 'key mode', 'organization'] as const)(
    'does not append an event or paired D1 effects when %s changes before a pass update',
    async (invalidation) => {
      const pass = await kit.pass();
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
      const keyAuthority =
        invalidation === 'api key' || invalidation === 'key scope' || invalidation === 'key mode';
      const headers = keyAuthority ? key.headers : member.session.headers;
      await kit.settle();
      const before = await effects(pass.id);
      const response = await withInterruption(
        'pass-cas',
        async (db) => {
          if (invalidation === 'api key')
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              key.id,
            ]);
          else if (invalidation === 'key scope')
            await editApiKeyIdentity(db, 'UPDATE api_keys SET scopes = ? WHERE id = ?', [
              '["passes:read"]',
              key.id,
            ]);
          else if (invalidation === 'key mode')
            await editApiKeyIdentity(db, "UPDATE api_keys SET mode = 'test' WHERE id = ?", [
              key.id,
            ]);
          else if (invalidation === 'organization') {
            // access_revision moves with status only: suspend and reactivate, not an updated_at touch.
            await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
            await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
          } else if (invalidation === 'membership')
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              member.membership,
            ]);
          else
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              await sha256Hex(member.session.cookieValue),
            ]);
        },
        async () =>
          app.request(
            `${ORIGIN}/api/v1/passes/${pass.id}`,
            {
              method: 'PATCH',
              headers: {
                ...headers,
                origin: ORIGIN,
                'content-type': 'application/json',
                'if-match': '"1"',
              },
              body: JSON.stringify({ input: { memberName: 'Should not publish' } }),
            },
            kit.env,
          ),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await effects(pass.id)).toEqual(before);
    },
    60_000,
  );

  it('does not refuse a tenant update because the org timestamp moved', async () => {
    const pass = await kit.pass();
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const response = await withInterruption(
      'pass-cas',
      async (db) => {
        await run(db, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [kit.org.id]);
      },
      async () =>
        app.request(
          `${ORIGIN}/api/v1/passes/${pass.id}`,
          {
            method: 'PATCH',
            headers: {
              ...member.session.headers,
              origin: ORIGIN,
              'content-type': 'application/json',
              'if-match': '"1"',
            },
            body: JSON.stringify({ input: { memberName: 'Published after a timestamp touch' } }),
          },
          kit.env,
        ),
    );
    expect(response.status).toBe(200);
  }, 60_000);

  it('records a successful tenant update with its pass version and event actor', async () => {
    const pass = await kit.pass();
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const response = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}`,
      {
        method: 'PATCH',
        headers: {
          ...member.session.headers,
          origin: ORIGIN,
          'content-type': 'application/json',
          'if-match': '"1"',
        },
        body: JSON.stringify({ input: { memberName: 'Published by operator' } }),
      },
      kit.env,
    );
    expect(response.status).toBe(200);
    expect(await first(kit.env.DB, 'SELECT version FROM passes WHERE id = ?', [pass.id])).toEqual({
      version: 2,
    });
    expect(
      await first(
        kit.env.DB,
        "SELECT actor_type, actor_id FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated'",
        [pass.id],
      ),
    ).toEqual({ actor_type: 'user', actor_id: member.user.id });
    expect(
      await first(
        kit.env.DB,
        'SELECT version FROM pass_versions WHERE pass_id = ? AND version = 2',
        [pass.id],
      ),
    ).toEqual({ version: 2 });
  }, 60_000);
});
