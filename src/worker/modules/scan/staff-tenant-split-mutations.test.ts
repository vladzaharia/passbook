import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeScanner,
  makeScanStaff,
  makeSession,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let orgId: StaffTenantFixture['orgId'];
let grant: StaffTenantFixture['grant'];
let state: StaffTenantFixture['state'];
let fixture: StaffTenantFixture;

beforeEach(async () => {
  fixture = await makeStaffTenantFixture();
  ({ env, f, orgId, grant, state } = fixture);
});

type Operation = 'create' | 'disable' | 'reset';
type Invalidation =
  | 'membership revoked'
  | 'session revoked'
  | 'session replaced'
  | 'session expired'
  | 'session idle expired'
  | 'user disabled'
  | 'org suspended'
  | 'membership downgraded'
  | 'membership replaced';
const races: [Operation, Invalidation][] = (['create', 'disable', 'reset'] as const).flatMap(
  (operation) =>
    (
      [
        'membership revoked',
        'session revoked',
        'session replaced',
        'session expired',
        'session idle expired',
        'user disabled',
        'org suspended',
        'membership downgraded',
        'membership replaced',
      ] as const
    ).map((invalidation) => [operation, invalidation] as [Operation, Invalidation]),
);

async function invalidateAuthority(
  fixture: StaffTenantFixture,
  invalidation: Invalidation,
  membershipId: string,
) {
  const { env, clock, session, f, userId, orgId, grant } = fixture;
  if (invalidation === 'session revoked' || invalidation === 'session replaced') {
    if (invalidation === 'session replaced')
      await makeSession(f, { userId, roles: ['admin', 'user'] });
    await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      clock.now(),
      await sha256Hex(session.cookieValue),
    ]);
  } else if (invalidation === 'session expired') {
    await withoutTrigger(env.DB, 'sessions_authority_immutable', async () => {
      await run(env.DB, 'UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [
        clock.now(),
        await sha256Hex(session.cookieValue),
      ]);
    });
  } else if (invalidation === 'session idle expired') {
    await run(env.DB, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
      clock.now(),
      await sha256Hex(session.cookieValue),
    ]);
  } else if (invalidation === 'user disabled') {
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [userId]);
  } else if (invalidation === 'org suspended') {
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
  } else {
    await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      clock.now(),
      membershipId,
    ]);
    if (invalidation === 'membership replaced') await grant();
    if (invalidation === 'membership downgraded') await grant(['read_only']);
  }
}

async function requestMutation(
  fixture: StaffTenantFixture,
  operation: Operation,
  personId: string,
  requestEnv: AppEnv,
) {
  const { call, headers, orgId, staffPath, resetPath } = fixture;
  return operation === 'create'
    ? call('POST', '', { orgId, name: 'Race', role: 'door' }, headers(), requestEnv)
    : operation === 'disable'
      ? call('PATCH', staffPath(personId), { disabled: true }, headers(), requestEnv)
      : call('POST', resetPath(personId), undefined, headers(), requestEnv);
}

describe('staff mutations fence the captured authority at commit', () => {
  it.each(races)('rejects %s when %s after authorization', async (operation, invalidation) => {
    const membershipId = await grant();
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    await makeScanner(f, { orgId, staffId: person.id });
    await makeScanner(f, { orgId, staffId: person.id, mode: 'test' });
    const before = await state();
    let intercepted = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 2) return target.batch(statements);
            intercepted++;
            await invalidateAuthority(fixture, invalidation, membershipId);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const requestEnv = { ...env, DB: db };
    const response = await requestMutation(fixture, operation, person.id, requestEnv);
    expect(intercepted).toBe(1);
    expect(response.status).toBe(403);
    expect(await state()).toEqual(before);
  });
});
