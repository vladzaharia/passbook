import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { hashPin } from './staff-pin.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let clock: StaffTenantFixture['clock'];
let orgId: StaffTenantFixture['orgId'];
let session: StaffTenantFixture['session'];
let headers: StaffTenantFixture['headers'];
let staffPath: StaffTenantFixture['staffPath'];
let resetPath: StaffTenantFixture['resetPath'];
let call: StaffTenantFixture['call'];
let grant: StaffTenantFixture['grant'];

beforeEach(async () => {
  ({ env, f, clock, orgId, session, headers, staffPath, resetPath, call, grant } =
    await makeStaffTenantFixture());
});

describe('staff read and response authority', () => {
  it('rolls back a staff update if authority is lost before its transaction', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId });
    let intercepted = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 2) return target.batch(statements);
            intercepted++;
            await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              await sha256Hex(session.cookieValue),
            ]);
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await call('PATCH', staffPath(person.id), { role: 'manager' }, headers(), {
      ...env,
      DB: db,
    });
    expect(intercepted).toBe(1);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('role');
    expect(await first(env.DB, 'SELECT role FROM scan_staff WHERE id = ?', [person.id])).toEqual({
      role: 'door',
    });
  });

  it('returns the committed PIN when the session is revoked after a reset', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const before = await first<{ pin_hash: string }>(
      env.DB,
      'SELECT pin_hash FROM scan_staff WHERE id = ?',
      [person.id],
    );
    let intercepted = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 2) return target.batch(statements);
            const result = await target.batch(statements);
            if (!intercepted++) {
              await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                clock.now(),
                await sha256Hex(session.cookieValue),
              ]);
            }
            return result;
          };
        }
        if (prop === 'prepare')
          return (sql: string) => {
            if (intercepted && /\b(?:FROM|JOIN)\s+scan_staff\b/i.test(sql))
              throw new Error('Staff was reread after session revocation');
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const requestEnv = { ...env, DB: db };
    const response = await call('POST', resetPath(person.id), undefined, headers(), requestEnv);
    expect(intercepted).toBe(1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pin: string };
    expect(body.pin).toMatch(/^\d{6}$/);
    const after = await first<{ pin_hash: string }>(
      env.DB,
      'SELECT pin_hash FROM scan_staff WHERE id = ?',
      [person.id],
    );
    expect(after?.pin_hash).toBe(await hashPin(env, person.id, body.pin));
    expect(after?.pin_hash).not.toBe(before?.pin_hash);
  });
});
