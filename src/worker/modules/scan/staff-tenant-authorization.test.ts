import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff, makeSession } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { makeStaffTenantFixture, type StaffTenantFixture } from './staff-tenant-split-fixture.ts';

let env: StaffTenantFixture['env'];
let f: StaffTenantFixture['f'];
let fake: StaffTenantFixture['fake'];
let orgId: StaffTenantFixture['orgId'];
let foreignOrgId: StaffTenantFixture['foreignOrgId'];
let userId: StaffTenantFixture['userId'];
let setSession: StaffTenantFixture['setSession'];
let headers: StaffTenantFixture['headers'];
let orgQuery: StaffTenantFixture['orgQuery'];
let staffPath: StaffTenantFixture['staffPath'];
let resetPath: StaffTenantFixture['resetPath'];
let call: StaffTenantFixture['call'];
let grant: StaffTenantFixture['grant'];
let state: StaffTenantFixture['state'];

beforeEach(async () => {
  ({
    env,
    f,
    fake,
    orgId,
    foreignOrgId,
    userId,
    setSession,
    headers,
    orgQuery,
    staffPath,
    resetPath,
    call,
    grant,
    state,
  } = await makeStaffTenantFixture());
});

describe('staff route tenant authorization', () => {
  it('does not treat a platform admin as an organization member', async () => {
    const person = await makeScanStaff(f, { orgId });
    const scanner = await makeScanner(f, { orgId, staffId: person.id });
    const before = await state();
    const list = await call('GET', orgQuery());
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
    for (const [method, path, body] of [
      ['POST', '', { orgId, name: 'No grant', role: 'door' }],
      ['PATCH', staffPath(person.id), { disabled: true }],
      ['POST', resetPath(person.id), undefined],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(404);
    }
    expect(await state()).toEqual(before);
    expect(
      (
        await first<{ staff_id: string | null }>(
          env.DB,
          'SELECT staff_id FROM scanners WHERE id = ?',
          [scanner.id],
        )
      )?.staff_id,
    ).toBe(person.id);
  });

  it('allows an organization administrator without platform admin in either mode', async () => {
    await grant();
    setSession(await makeSession(f, { userId, roles: ['user'] }));
    const made = await call(
      'POST',
      '',
      { orgId, name: 'Taylor', role: 'door' },
      {
        ...headers(),
        'x-passbook-mode': 'test',
      },
    );
    expect(made.status).toBe(201);
    const created = (await made.json()) as { staff: { id: string; orgId: string }; pin: string };
    expect(created.staff.orgId).toBe(orgId);
    expect(created.pin).toMatch(/^\d{6}$/);
    for (const mode of ['live', 'test']) {
      const list = await call('GET', orgQuery(), undefined, {
        ...headers(),
        'x-passbook-mode': mode,
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ items: [{ id: created.staff.id }] });
    }
    expect((await call('PATCH', staffPath(created.staff.id), { role: 'manager' })).status).toBe(
      200,
    );
    const reset = await call('POST', resetPath(created.staff.id));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ pin: expect.stringMatching(/^\d{6}$/) });
  });

  it('masks cross-organization rows, including when their true org is supplied', async () => {
    await grant();
    const ours = await makeScanStaff(f, { orgId, name: 'Ours' });
    const foreign = await makeScanStaff(f, { orgId: foreignOrgId, name: 'Foreign' });
    await makeScanner(f, { orgId: foreignOrgId, staffId: foreign.id });
    const before = await state();
    const ownList = await call('GET', orgQuery());
    expect(await ownList.json()).toMatchObject({ items: [{ id: ours.id }] });
    const foreignList = await call('GET', orgQuery(foreignOrgId));
    expect(foreignList.status).toBe(200);
    expect(await foreignList.json()).toEqual({ items: [] });
    expect(
      (await call('POST', '', { orgId: foreignOrgId, name: 'No access', role: 'door' })).status,
    ).toBe(404);
    for (const org of [orgId, foreignOrgId]) {
      for (const id of [foreign.id, 'missing-staff']) {
        for (const [method, path, body] of [
          ['PATCH', staffPath(id, org), { disabled: true }],
          ['POST', resetPath(id, org), undefined],
        ] as const) {
          const response = await call(method, path, body);
          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({ code: 'SCAN_STAFF_NOT_FOUND' });
        }
      }
    }
    expect(await state()).toEqual(before);
  });

  it.each([
    ['read_only', 200],
    ['template_author', 403],
  ] as const)('enforces scanning capabilities for a %s member', async (role, listStatus) => {
    await grant([role]);
    const person = await makeScanStaff(f, { orgId });
    const before = await state();
    const list = await call('GET', orgQuery());
    expect(list.status).toBe(listStatus);
    if (listStatus === 200) expect(await list.json()).toMatchObject({ items: [{ id: person.id }] });
    for (const [method, path, body] of [
      ['POST', '', { orgId, name: 'Forbidden', role: 'door' }],
      ['PATCH', staffPath(person.id), { disabled: true }],
      ['POST', resetPath(person.id), undefined],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(403);
    }
    expect(await state()).toEqual(before);
  });

  it('continues to reject scanner and API-key principals', async () => {
    await grant();
    const person = await makeScanStaff(f, { orgId });
    for (const principal of [
      fake.apiKey({ orgId, scopes: ['scans:read'] }),
      fake.apiKey(),
      fake.scanner({ orgId }),
      fake.scanner({ orgId, transport: 'bearer' }),
    ]) {
      for (const [method, path, body] of [
        ['GET', orgQuery(), undefined],
        ['POST', '', { orgId, name: 'Machine', role: 'door' }],
        ['PATCH', staffPath(person.id), { role: 'manager' }],
        ['POST', resetPath(person.id), undefined],
      ] as const) {
        expect((await call(method, path, body, principal)).status).toBe(401);
      }
    }
  });

  it('rolls back staff creation when its audit insert fails', async () => {
    await grant();
    const before = await state();
    await run(
      env.DB,
      `CREATE TRIGGER fail_tenant_staff_create_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'scan_staff.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    try {
      const response = await call('POST', '', { orgId, name: 'No audit', role: 'door' });
      expect(response.status).toBe(500);
      expect(await state()).toEqual(before);
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_tenant_staff_create_audit');
    }
  });
});
