import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editSessionAuthority, makeApiKey } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from './service.ts';
import {
  create,
  f,
  h,
  keyBody,
  keyState,
  member,
  org,
  platformSession,
  revoke,
  setup,
  teardown,
} from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

/** Pause immediately before the actual D1 batch, after the route has resolved its authority. */
async function beforeKeyBatch<T>(
  action: 'create' | 'revoke',
  intervene: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
): Promise<T> {
  const db = h.env.DB;
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  let intercepted = 0;
  const matches =
    action === 'create'
      ? /\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+api_keys\b/i
      : /\bUPDATE\s+api_keys\s+SET\b/i;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(prepared, member) {
              if (member === 'bind') {
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              }
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (
            intercepted === 0 &&
            statements.some((statement) => matches.test(sqlOf.get(statement) ?? ''))
          ) {
            intercepted++;
            await intervene(db);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(h.env, { DB: proxy });
  try {
    const result = await call();
    expect(intercepted, `the ${action} key batch was reached`).toBe(1);
    return result;
  } finally {
    Object.assign(h.env, { DB: db });
  }
}

describe('API key commit authority', () => {
  it.each([
    ['create', 'session'],
    ['revoke', 'session'],
    ['create', 'membership'],
    ['revoke', 'membership'],
  ] as const)(
    'does not %s a key if the %s is revoked before commit',
    async (action, invalidated) => {
      const { session, membershipId } = await member('integration_admin');
      const key = await makeApiKey(f(), { orgId: org.id, scopes: ['passes:read'] });
      const sessionId = await sha256Hex(session.cookieValue);
      const before = await keyState();
      const response = await beforeKeyBatch(
        action,
        async (db) => {
          const result =
            invalidated === 'session'
              ? await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                  h.clock.now(),
                  sessionId,
                ])
              : await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                  h.clock.now(),
                  membershipId,
                ]);
          expect(result).toEqual({ changes: 1 });
        },
        () =>
          action === 'create'
            ? create(session.headers, { ...keyBody(org.id), scopes: ['connections:read'] })
            : revoke(session.headers, key.id, org.id),
      );
      expect(response.status).toBe(403);
      expect(await keyState()).toEqual(before);
      expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
        keyId: key.id,
      });
    },
  );

  it.each(['create', 'revoke'] as const)(
    'does not %s with a replaced membership even if the replacement has the same role',
    async (action) => {
      const { session, membershipId, user } = await member('integration_admin');
      const key = await makeApiKey(f(), { orgId: org.id });
      const before = await keyState();
      const fx = f();
      const now = h.clock.now();
      const invitationId = fx.ids.id();
      const response = await beforeKeyBatch(
        action,
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            now,
            membershipId,
          ]);
          await run(
            db,
            `INSERT INTO org_invitations
              (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
             SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
            [
              invitationId,
              org.id,
              '["integration_admin"]',
              fx.ids.token(),
              now,
              now + 3600_000,
              now,
              user.id,
            ],
          );
          await run(
            db,
            `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [fx.ids.id(), org.id, user.id, invitationId, '["integration_admin"]', now],
          );
        },
        () =>
          action === 'create'
            ? create(session.headers, { ...keyBody(org.id), scopes: ['connections:read'] })
            : revoke(session.headers, key.id, org.id),
      );
      expect(response.status).toBe(403);
      expect(await keyState()).toEqual(before);
    },
  );

  it.each([
    ['create', 'session'],
    ['revoke', 'session'],
    ['create', 'role'],
    ['revoke', 'role'],
  ] as const)(
    'does not %s a platform key if the administrator %s is revoked before commit',
    async (action, invalidated) => {
      const session = await platformSession();
      const key = await makeApiKey(f());
      const before = await keyState();
      const sessionId = await sha256Hex(session.cookieValue);
      const response = await beforeKeyBatch(
        action,
        async (db) => {
          const changed =
            invalidated === 'session'
              ? await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                  h.clock.now(),
                  sessionId,
                ])
              : await editSessionAuthority(db, 'UPDATE sessions SET roles = ? WHERE id_hash = ?', [
                  '["user"]',
                  sessionId,
                ]);
          expect(changed).toEqual({ changes: 1 });
        },
        () =>
          action === 'create'
            ? create(session.headers, keyBody(null))
            : revoke(session.headers, key.id),
      );
      expect(response.status).toBe(403);
      expect(await keyState()).toEqual(before);
      expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
        keyId: key.id,
      });
    },
  );
});
