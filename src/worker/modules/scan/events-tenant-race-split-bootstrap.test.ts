import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { ScanEventSchema } from '../../../shared/contracts/index.ts';
import { first, run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';

const HOUR = 3_600_000;
const race = createEventTenantRace();
let { env, f, clock, orgId, templateId, eventId, member, membershipId } = race;
beforeEach(() => {
  ({ env, f, clock, orgId, templateId, eventId, member, membershipId } = race);
});
const { atEventCommit, atEventRead, call, state } = race;

describe('event mutation commit authority', () => {
  const operations = [
    [
      'create',
      () =>
        call('POST', '', {
          orgId,
          name: 'New event',
          templateIds: [templateId],
          opensAt: clock.now() - HOUR,
          closesAt: clock.now() + HOUR,
          timeZone: 'UTC',
        }),
    ],
  ] as const;

  it('creates an event without a credential keyset: a mutation does not depend on it', async () => {
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
    ).toBeNull();
    const response = await operations[0][1]();
    expect(response.status).toBe(201);
    expect(ScanEventSchema.parse(await response.json()).arrived).toBe(0);
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
    ).toBeNull();
  });

  it('binds the session secret only as a scalar, never inside JSON parameters', async () => {
    const sessionHash = await hashSessionCookie(member.cookieValue);
    const session = await first<{ csrf_secret: string }>(
      env.DB,
      'SELECT csrf_secret FROM sessions WHERE id_hash=?',
      [sessionHash],
    );
    if (!session?.csrf_secret) throw new Error('Missing session secret fixture.');
    const secret = session.csrf_secret;
    const real = env.DB;
    let scalarSeen = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  for (const value of values) {
                    if (value === secret) scalarSeen = true;
                    else if (typeof value === 'string') expect(value).not.toContain(secret);
                  }
                  return prepared.bind(...values);
                };
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await call('GET', `/${eventId}`);
      expect(response.status).toBe(200);
      expect(scalarSeen).toBe(true);
    } finally {
      Object.assign(env, { DB: real });
    }
  });

  it('pins the key ring before asynchronous event authorization', async () => {
    await ensureCredentialRefKeyset(env.DB, env);
    const key = env.KEK_V1;
    try {
      const response = await atEventRead(
        'detail',
        'target',
        async () => {
          Object.assign(env, { KEK_V1: btoa('z'.repeat(32)) });
        },
        () => call('GET', `/${eventId}`),
      );
      expect(response.status).toBe(200);
      expect(ScanEventSchema.parse(await response.json()).id).toBe(eventId);
    } finally {
      Object.assign(env, { KEK_V1: key });
    }
  });

  it.each([
    ['list', () => call('GET', `?orgId=${orgId}`)],
    ['detail', () => call('GET', `/${eventId}`)],
    ['create', () => operations[0][1]()],
    ['update', () => call('PATCH', `/${eventId}`, { name: 'Denied' })],
  ] as const)(
    'denies a %s whose membership is revoked at the guarded step',
    async (kind, operation) => {
      const before = await state();
      const revoke = async (db: D1Database) => {
        await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          clock.now(),
          membershipId,
        ]);
      };
      // Reads race the row read; mutations race their guarded write.
      const response =
        kind === 'list' || kind === 'detail'
          ? await atEventRead(kind, 'before-row', revoke, operation)
          : await atEventCommit(revoke, operation);
      if (kind === 'list') {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ items: [], nextCursor: null });
      } else {
        expect(response.status).toBe(403);
      }
      expect(await state()).toEqual(before);
    },
  );

  it('masks an event that moves to another tenant before the guarded read', async () => {
    const other = await makeOrg(f);
    const response = await atEventRead(
      'detail',
      'before-row',
      async (db) => {
        await run(db, 'UPDATE scan_events SET org_id=? WHERE id=?', [other.id, eventId]);
      },
      () => call('GET', `/${eventId}`),
    );
    expect(response.status).toBe(404);
  });
});
