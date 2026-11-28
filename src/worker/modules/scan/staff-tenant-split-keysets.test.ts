import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff, withoutTrigger } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { beforeStatement } from './batch-interceptor-test-support.ts';
import { RACE_STAFF_STARTS } from './race-tags.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let clock: StaffTenantFixture['clock'];
let orgId: StaffTenantFixture['orgId'];
let session: StaffTenantFixture['session'];
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
    'resets a PIN without a keyset, and a %s read answers without initializing one',
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
      // A read never initializes the keyset: only a signed scan's name needs it, and none exists.
      expect(await first(env.DB, 'SELECT id FROM credential_ref_keyset')).toBeNull();
    },
  );

  it('lists nothing and initializes no keyset when the session is revoked before the roster read', async () => {
    await grant();
    await makeScanStaff(f, { orgId, pin: '482913' });
    await withoutTrigger(env.DB, 'credential_ref_keyset_no_delete', async () => {
      await run(env.DB, 'DELETE FROM credential_ref_keyset');
    });
    const before = await state();
    const control = await call('GET', orgQuery());
    expect(control.status).toBe(200);
    expect(((await control.json()) as { items: unknown[] }).items).toHaveLength(1);
    const { result: response, fired } = await beforeStatement(
      env,
      RACE_STAFF_STARTS,
      async (real) => {
        await run(real, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          clock.now(),
          await sha256Hex(session.cookieValue),
        ]);
      },
      async () => call('GET', orgQuery()),
    );
    expect(fired).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(await first(env.DB, 'SELECT id FROM credential_ref_keyset')).toBeNull();
    expect(await state()).toEqual(before);
  });

  it('needs no keyset for staff without a signed scan, and allows staff writes and PIN reset', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    await makeScanner(f, { orgId, staffId: person.id });
    const original = await ensureCredentialRefKeyset(env.DB, env);
    const before = await state();
    await forceKeyset(original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64));
    try {
      const list = await call('GET', orgQuery());
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ items: [{ id: person.id, lastScan: null }] });
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
