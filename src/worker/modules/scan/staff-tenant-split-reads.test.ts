import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff, makeSession } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getStaff } from './repo-staff.ts';
import { createStaff, listStaff, resetStaffPin, updateStaff } from './staff-admin.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let clock: StaffTenantFixture['clock'];
let orgId: StaffTenantFixture['orgId'];
let userId: StaffTenantFixture['userId'];
let session: StaffTenantFixture['session'];
let headers: StaffTenantFixture['headers'];
let orgQuery: StaffTenantFixture['orgQuery'];
let call: StaffTenantFixture['call'];
let grant: StaffTenantFixture['grant'];
let state: StaffTenantFixture['state'];
let forceKeyset: StaffTenantFixture['forceKeyset'];

beforeEach(async () => {
  ({ env, f, clock, orgId, userId, session, headers, orgQuery, call, grant, state, forceKeyset } =
    await makeStaffTenantFixture());
});

describe('staff read and response authority', () => {
  it('rejects a caller that differs from the captured session or mode', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId });
    const observed = await getStaff(env.DB, orgId, person.id);
    if (!observed) throw new Error('Missing staff');
    const ctx = createServiceContext(env, { clock });
    const store = createSessionStore(env, clock);
    const current = await store.resolve(session.cookieValue);
    const replacement = await makeSession(f, { userId, roles: ['admin', 'user'] });
    const different = await store.resolve(replacement.cookieValue);
    if (!current || !different) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(ctx, current, orgId, 'scanning:manage');
    const readAuthority = await tenantAuthorityOf(ctx, current, orgId, 'scanning:read');
    if (authority.kind !== 'session' || readAuthority.kind !== 'session')
      throw new Error('Expected session authorities');
    const before = await state();
    for (const mismatched of [
      different,
      { ...current, mode: 'test' as const },
      { ...current, userId: 'another-user' },
      { ...current, amr: 'magic_link' as const },
      { ...current, roles: ['user'] as typeof current.roles },
      { ...current, kind: 'api_key' } as unknown as typeof current,
    ]) {
      await expect(listStaff(ctx, mismatched, readAuthority, orgId, 'live')).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        createStaff(ctx, mismatched, authority, 'live', {
          orgId,
          name: 'Wrong principal',
          role: 'door',
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        updateStaff(ctx, mismatched, authority, observed, 'live', {
          role: 'manager',
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(resetStaffPin(ctx, mismatched, authority, observed)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(await state()).toEqual(before);
  });

  it('pins the complete request KEK ring before asynchronous staff proof work', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId });
    await ensureCredentialRefKeyset(env.DB, env);
    const ctx = createServiceContext(env, { clock });
    const current = await createSessionStore(env, clock).resolve(session.cookieValue);
    if (!current) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(ctx, current, orgId, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    let intercepted = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          const value = Reflect.get(target, prop, target);
          if (prop === 'first')
            return async (...values: unknown[]) => {
              intercepted++;
              Object.assign(requestEnv, { KEK_V0: btoa('z'.repeat(32)) });
              return (value as (...args: unknown[]) => Promise<unknown>).apply(target, values);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            sql.includes('SELECT s.csrf_secret,s.created_at,s.expires_at')
              ? wrap(target.prepare(sql))
              : target.prepare(sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const requestEnv = { ...env, DB: db };
    const result = await listStaff({ ...ctx, env: requestEnv }, current, authority, orgId, 'live');
    expect(intercepted).toBe(1);
    expect(result.items).toMatchObject([{ id: person.id, today: 0, lastScan: null }]);
  });

  it.each([
    'membership revoked',
    'membership replaced',
    'session revoked',
    'org suspended',
    'timezone changed',
  ] as const)('fences %s in the same snapshot as returned staff activity', async (change) => {
    const membershipId = await grant();
    await makeScanStaff(f, { orgId, name: 'Private staff' });
    const scanner = change === 'timezone changed' ? await makeScanner(f, { orgId }) : null;
    let intercepted = 0;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
          const value = Reflect.get(target, prop, target);
          if (prop === 'all' && /\bWITH starts AS\b/i.test(sql)) {
            return async (...values: unknown[]) => {
              if (!intercepted++) {
                if (change === 'session revoked') {
                  await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                    clock.now(),
                    await sha256Hex(session.cookieValue),
                  ]);
                } else if (change === 'org suspended') {
                  await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
                } else if (change === 'timezone changed') {
                  await run(
                    env.DB,
                    "UPDATE scanners SET time_zone = 'America/Los_Angeles' WHERE id = ?",
                    [scanner?.id ?? null],
                  );
                } else {
                  await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                    clock.now(),
                    membershipId,
                  ]);
                  if (change === 'membership replaced') await grant();
                }
              }
              return (value as (...args: unknown[]) => Promise<unknown>).apply(target, values);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            /\bWITH starts AS\b/i.test(sql) ? wrap(target.prepare(sql), sql) : target.prepare(sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await call('GET', orgQuery(), undefined, headers(), { ...env, DB: db });
    expect(intercepted).toBe(1);
    if (change === 'timezone changed') {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
    } else {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [] });
    }
  });

  it.each(['empty roster', 'staff without scans'] as const)(
    'rejects a changed keyset at the final read for %s',
    async (scenario) => {
      await grant();
      if (scenario === 'staff without scans') await makeScanStaff(f, { orgId });
      const original = await ensureCredentialRefKeyset(env.DB, env);
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, prop) {
            if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            const value = Reflect.get(target, prop, target);
            if (prop === 'all')
              return async (...values: unknown[]) => {
                intercepted++;
                await forceKeyset(original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64));
                return (value as (...args: unknown[]) => Promise<unknown>).apply(target, values);
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) =>
              /\bWITH starts AS\b/i.test(sql) ? wrap(target.prepare(sql)) : target.prepare(sql);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const response = await call('GET', orgQuery(), undefined, headers(), { ...env, DB: db });
        expect(intercepted).toBe(1);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
      } finally {
        await forceKeyset(original);
      }
    },
  );
});
