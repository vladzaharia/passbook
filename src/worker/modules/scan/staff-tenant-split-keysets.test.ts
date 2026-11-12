import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff, withoutTrigger } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let clock: StaffTenantFixture['clock'];
let orgId: StaffTenantFixture['orgId'];
let session: StaffTenantFixture['session'];
let headers: StaffTenantFixture['headers'];
let orgQuery: StaffTenantFixture['orgQuery'];
let staffPath: StaffTenantFixture['staffPath'];
let resetPath: StaffTenantFixture['resetPath'];
let call: StaffTenantFixture['call'];
let grant: StaffTenantFixture['grant'];
let state: StaffTenantFixture['state'];
let forceKeyset: StaffTenantFixture['forceKeyset'];

beforeEach(async () => {
  ({
    env,
    f,
    clock,
    orgId,
    session,
    headers,
    orgQuery,
    staffPath,
    resetPath,
    call,
    grant,
    state,
    forceKeyset,
  } = await makeStaffTenantFixture());
});

describe('staff keyset bootstrap and availability', () => {
  it.each(['list', 'create'] as const)(
    'resets a PIN without a keyset and initializes it for the %s activity projection',
    async (operation) => {
      await grant();
      const person = await makeScanStaff(f, { orgId, pin: '482913' });
      await withoutTrigger(env.DB, 'credential_ref_keyset_no_delete', async () => {
        await run(env.DB, 'DELETE FROM credential_ref_keyset');
      });
      const reset = await call('POST', resetPath(person.id));
      expect(reset.status).toBe(200);
      expect(await first(env.DB, 'SELECT id FROM credential_ref_keyset')).toBeNull();
      const response =
        operation === 'list'
          ? await call('GET', orgQuery())
          : await call('POST', '', { orgId, name: 'Fresh staff', role: 'door' });
      expect(response.status).toBe(operation === 'list' ? 200 : 201);
      const body = await response.json();
      if (operation === 'list')
        expect(body).toMatchObject({ items: [{ id: person.id, today: 0, lastScan: null }] });
      else expect(body).toMatchObject({ staff: { name: 'Fresh staff', today: 0, lastScan: null } });
      expect(await first(env.DB, 'SELECT id FROM credential_ref_keyset')).toEqual({ id: 1 });
    },
  );

  it.each(['list'] as const)(
    'does not bootstrap a keyset for %s after the captured session is revoked',
    async (operation) => {
      await grant();
      const person = await makeScanStaff(f, { orgId, pin: '482913' });
      await withoutTrigger(env.DB, 'credential_ref_keyset_no_delete', async () => {
        await run(env.DB, 'DELETE FROM credential_ref_keyset');
      });
      const before = await state();
      let intercepted = 0;
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (statements.length === 2 && !intercepted++) {
                await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                  clock.now(),
                  await sha256Hex(session.cookieValue),
                ]);
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const requestEnv = { ...env, DB: db };
      const response =
        operation === 'list'
          ? await call('GET', orgQuery(), undefined, headers(), requestEnv)
          : operation === 'create'
            ? await call(
                'POST',
                '',
                { orgId, name: 'Unauthorized', role: 'door' },
                headers(),
                requestEnv,
              )
            : await call('PATCH', staffPath(person.id), { role: 'manager' }, headers(), requestEnv);
      expect(intercepted).toBe(1);
      expect(response.status).toBe(operation === 'list' ? 200 : 403);
      if (operation === 'list') expect(await response.json()).toEqual({ items: [] });
      expect(await first(env.DB, 'SELECT id FROM credential_ref_keyset')).toBeNull();
      expect(await state()).toEqual(before);
    },
  );

  it('fails closed on a mismatched keyset for activity while allowing staff writes and PIN reset', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    await makeScanner(f, { orgId, staffId: person.id });
    const original = await ensureCredentialRefKeyset(env.DB, env);
    const before = await state();
    await forceKeyset(original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64));
    try {
      const list = await call('GET', orgQuery());
      expect(list.status).toBe(503);
      expect(await list.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      expect(await state()).toEqual(before);
      // Staff writes never read the keyset: the committed account answers without activity.
      const created = await call('POST', '', { orgId, name: 'Unavailable', role: 'door' });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        staff: { name: 'Unavailable', today: 0, lastScan: null },
      });
      const reset = await call('POST', resetPath(person.id));
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ pin: expect.stringMatching(/^\d{6}$/) });
      expect(
        await first(env.DB, 'SELECT staff_id FROM scanners WHERE org_id = ?', [orgId]),
      ).toEqual({ staff_id: null });
      const disabled = await call('PATCH', staffPath(person.id), { disabled: true });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ id: person.id, lastScan: null });
    } finally {
      await forceKeyset(original);
    }
  });
});
