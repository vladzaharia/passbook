import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { setupStaffAdminTestKit, WireStaffSchema } from './staff-admin-test-fixtures.ts';
import { hashPin } from './staff-pin.ts';
import { grantScanMembership } from './test-kit.ts';

const staffAdmin = setupStaffAdminTestKit();
const { binding, codeOf, create, credential, itemPath, list, send } = staffAdmin;
let env: typeof staffAdmin.env;
let f: typeof staffAdmin.f;
let clock: typeof staffAdmin.clock;
let orgId: typeof staffAdmin.orgId;
let userId: typeof staffAdmin.userId;
beforeEach(() => {
  ({ env, f, clock, orgId, userId } = staffAdmin);
});

describe('staff records and credentials', () => {
  it('shares accounts across modes, stores a staff-specific HMAC and reveals the PIN only on creation', async () => {
    const made = await create('  Jordan  ', 'desk', orgId, 'test');
    expect(made.pin).toMatch(/^\d{6}$/);
    expect(made.staff).toMatchObject({
      orgId,
      name: 'Jordan',
      role: 'desk',
      pinSetAt: clock.now(),
      disabledAt: null,
      locked: false,
      today: 0,
      lastScan: null,
    });
    const stored = await credential(made.staff.id);
    if (!stored) throw new Error('Staff credential missing');
    expect(stored.pin_hash).toBe(await hashPin(env, made.staff.id, made.pin));
    expect(stored.pin_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.pin_hash).not.toBe(made.pin);
    expect(stored.pin_hash).not.toBe(await hashPin(env, 'another-staff-id', made.pin));
    const record = await first<Record<string, unknown>>(
      env.DB,
      'SELECT * FROM scan_staff WHERE id = ?',
      [made.staff.id],
    );
    if (!record) throw new Error('Staff record missing');
    expect(record).not.toHaveProperty('pin');
    expect(Object.values(record)).not.toContain(made.pin);
    const live = await list();
    const test = await list(orgId, 'test');
    expect(live).toEqual([made.staff]);
    expect(test).toEqual([made.staff]);
    const updated = await send('PATCH', itemPath(made.staff.id), { role: 'manager' });
    expect(updated.status).toBe(200);
    const staff = WireStaffSchema.parse(await updated.json());
    expect(staff.role).toBe('manager');
    for (const dto of [made.staff, ...live, ...test, staff]) {
      expect(Object.keys(dto).sort()).toEqual(
        [
          'id',
          'orgId',
          'name',
          'role',
          'pinSetAt',
          'disabledAt',
          'locked',
          'today',
          'lastScan',
        ].sort(),
      );
      expect(JSON.stringify(dto)).not.toContain(stored.pin_hash);
    }
  });

  it('rejects invalid and unknown fields, including attempts to alter scanner roles', async () => {
    const person = await makeScanStaff(f, { orgId, role: 'door' });
    const scanner = await makeScanner(f, { orgId, staffId: person.id });
    const before = await binding(scanner.id);
    const invalidBodies = [
      { name: '' },
      { name: 'a'.repeat(41) },
      { name: 'Staff\nName' },
      { role: 'admin' },
      { role: 'manager', kind: 'terminal' },
      { role: 'manager', deviceRole: 'monitor' },
      { role: 'manager', device_role: 'monitor' },
      { role: 'manager', scannerId: scanner.id },
      { role: 'manager', pin: '123456' },
      { role: 'manager', pinHash: 'anything' },
      { role: 'manager', orgId: 'another-org' },
    ];
    for (const body of invalidBodies) {
      expect((await send('PATCH', itemPath(person.id), body)).status).toBe(422);
    }
    for (const extra of [
      { kind: 'terminal' },
      { deviceRole: 'monitor' },
      { device_role: 'monitor' },
      { scannerId: scanner.id },
      { pin: '123456' },
      { pinHash: 'anything' },
    ]) {
      expect(
        (await send('POST', '', { orgId, name: 'Injected', role: 'door', ...extra })).status,
      ).toBe(422);
    }
    expect(await binding(scanner.id)).toEqual(before);
    const res = await send('PATCH', itemPath(person.id), { name: 'Alex', role: 'manager' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: person.id, name: 'Alex', role: 'manager' });
    expect(await binding(scanner.id)).toEqual(before);
  });

  it('enforces case-insensitive uniqueness among enabled staff and on re-enable', async () => {
    const firstPerson = await create('Jordan');
    const duplicate = await send('POST', '', { orgId, name: 'jORdAN', role: 'desk' });
    expect(duplicate.status).toBe(409);
    expect(await codeOf(duplicate)).toBe('STAFF_NAME_TAKEN');
    clock.advance(1000);
    const disabled = await send('PATCH', itemPath(firstPerson.staff.id), { disabled: true });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ disabledAt: clock.now() });
    const replacement = await create('JORDAN', 'manager');
    const reenable = await send('PATCH', itemPath(firstPerson.staff.id), { disabled: false });
    expect(reenable.status).toBe(409);
    expect(await codeOf(reenable)).toBe('STAFF_NAME_TAKEN');
    expect((await credential(firstPerson.staff.id))?.disabled_at).toBe(clock.now());
    expect(
      (await send('PATCH', itemPath(firstPerson.staff.id), { name: 'Alex', disabled: false }))
        .status,
    ).toBe(200);
    const rows = await list();
    expect(rows.map((staff) => [staff.id, staff.name, staff.disabledAt])).toEqual([
      [firstPerson.staff.id, 'Alex', null],
      [replacement.staff.id, 'JORDAN', null],
    ]);
    const other = await makeOrg(f);
    await grantScanMembership(f, other.id, userId);
    expect((await create('Jordan', 'door', other.id)).staff.orgId).toBe(other.id);
  });
});
