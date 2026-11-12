import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import { StaffPinSchema } from '../../../shared/contracts/scanners.ts';
import { all, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff } from './repo-staff.ts';
import { createStaff, resetStaffPin } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import { hashPin } from './staff-pin.ts';

const staffAdmin = setupStaffAdminTestKit();
const {
  admin,
  binding,
  create,
  credential,
  itemPath,
  list,
  pinAttempt,
  resetPath,
  send,
  serviceAuthority,
} = staffAdmin;
let env: typeof staffAdmin.env;
let f: typeof staffAdmin.f;
let clock: typeof staffAdmin.clock;
let orgId: typeof staffAdmin.orgId;
let userId: typeof staffAdmin.userId;
beforeEach(() => {
  ({ env, f, clock, orgId, userId } = staffAdmin);
});

describe('staff records and credentials', () => {
  it('rotates the credential, reveals only the replacement and unbinds same-org devices in both modes', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const otherPerson = await makeScanStaff(f, { orgId, name: 'Another' });
    const otherOrg = await makeOrg(f);
    const live = await makeScanner(f, { orgId, staffId: person.id });
    const test = await makeScanner(f, { orgId, mode: 'test', staffId: person.id });
    const unrelated = await makeScanner(f, { orgId, staffId: otherPerson.id });
    // A mismatched legacy row must not allow one org to change a scanner owned by another.
    const foreign = await makeScanner(f, { orgId: otherOrg.id, staffId: person.id });
    const keepOther = await binding(unrelated.id);
    const keepForeign = await binding(foreign.id);
    const before = await credential(person.id);
    clock.advance(1000);
    const res = await send('POST', resetPath(person.id), undefined, admin('test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = StaffPinSchema.strict().parse(await res.json());
    expect(Object.keys(body)).toEqual(['pin']);
    expect(body.pin).not.toBe(person.pin);
    const after = await credential(person.id);
    expect(after).toMatchObject({ pin_set_at: clock.now(), disabled_at: null });
    expect(after?.pin_hash).toBe(await hashPin(env, person.id, body.pin));
    expect(after?.pin_hash).not.toBe(before?.pin_hash);
    await expect(pinAttempt(person.id, person.pin, live.id)).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
    await expect(pinAttempt(person.id, body.pin, live.id)).resolves.toBeUndefined();
    for (const scanner of [live, test]) {
      expect(await binding(scanner.id)).toMatchObject({
        staff_id: null,
        staff_since: null,
        staff_seen_at: null,
      });
    }
    expect(await binding(unrelated.id)).toEqual(keepOther);
    expect(await binding(foreign.id)).toEqual(keepForeign);
    for (const mode of ['live', 'test'] as const) {
      const dto = (await list(orgId, mode)).find((staff) => staff.id === person.id);
      expect(dto?.pinSetAt).toBe(clock.now());
      expect(dto).not.toHaveProperty('pin');
      expect(dto).not.toHaveProperty('pinHash');
    }
  });

  it('retries an entropy collision instead of allowing the old PIN to remain valid', async () => {
    const ctx = createServiceContext(env, { clock });
    const { auth, authority } = await serviceAuthority(ctx);
    const draws = ['000042', '000042', '900007'];
    let used = 0;
    ctx.ids.code = (digits) => {
      expect(digits).toBe(6);
      return draws[used++] ?? '900007';
    };
    const made = await createStaff(ctx, auth, authority, 'live', {
      orgId,
      name: 'Entropy',
      role: 'manager',
    });
    expect(made.pin).toBe('000042');
    const scanner = await makeScanner(f, { orgId, staffId: made.staff.id });
    const observed = await getStaff(env.DB, orgId, made.staff.id);
    if (!observed) throw new Error('Staff fixture missing');
    const rotated = await resetStaffPin(ctx, auth, authority, observed);
    expect(rotated.pin).toBe('900007');
    expect(used).toBe(3);
    expect((await credential(made.staff.id))?.pin_hash).toBe(
      await hashPin(env, made.staff.id, rotated.pin),
    );
    await expect(pinAttempt(made.staff.id, made.pin, scanner.id)).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
    await expect(pinAttempt(made.staff.id, rotated.pin, scanner.id)).resolves.toBeUndefined();
    expect(await binding(scanner.id)).toMatchObject({
      staff_id: null,
      staff_since: null,
      staff_seen_at: null,
    });
  });

  it('leaves the credential and bindings untouched if entropy repeatedly collides', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '000042' });
    const scanner = await makeScanner(f, { orgId, staffId: person.id });
    const original = await credential(person.id);
    const bound = await binding(scanner.id);
    const ctx = createServiceContext(env, { clock });
    const { auth, authority } = await serviceAuthority(ctx);
    const observed = await getStaff(env.DB, orgId, person.id);
    if (!observed) throw new Error('Staff fixture missing');
    let attempts = 0;
    ctx.ids.code = () => {
      attempts++;
      return person.pin;
    };
    await expect(resetStaffPin(ctx, auth, authority, observed)).rejects.toMatchObject({
      code: 'PIN_GENERATION_FAILED',
      status: 503,
    });
    expect(attempts).toBeGreaterThan(1);
    expect(await credential(person.id)).toEqual(original);
    expect(await binding(scanner.id)).toEqual(bound);
    expect(
      await all(env.DB, 'SELECT action FROM audit_log WHERE target_id = ?', [person.id]),
    ).toEqual([]);
  });

  it('disabling unbinds all same-org modes without changing scanner kinds or other bindings', async () => {
    const person = await makeScanStaff(f, { orgId });
    const otherPerson = await makeScanStaff(f, { orgId, name: 'Another' });
    const otherOrg = await makeOrg(f);
    const live = await makeScanner(f, { orgId, staffId: person.id });
    const test = await makeScanner(f, {
      orgId,
      mode: 'test',
      staffId: person.id,
      kind: 'terminal',
    });
    const revoked = await makeScanner(f, { orgId, staffId: person.id, revoked: true });
    const screen = await makeScanner(f, {
      orgId,
      mode: 'test',
      staffId: person.id,
      kind: 'display',
    });
    const unrelated = await makeScanner(f, { orgId, staffId: otherPerson.id });
    const foreign = await makeScanner(f, { orgId: otherOrg.id, staffId: person.id });
    const untouched = [await binding(unrelated.id), await binding(foreign.id)];
    const scanners = [live, test, revoked, screen];
    const before = await Promise.all(scanners.map((scanner) => binding(scanner.id)));
    clock.advance(1000);
    const res = await send('PATCH', itemPath(person.id), { disabled: true }, admin('test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: person.id, disabledAt: clock.now() });
    for (const [index, scanner] of scanners.entries()) {
      expect(await binding(scanner.id)).toEqual({
        ...before[index],
        staff_id: null,
        staff_since: null,
        staff_seen_at: null,
      });
    }
    expect([await binding(unrelated.id), await binding(foreign.id)]).toEqual(untouched);
    await expect(pinAttempt(person.id, person.pin, live.id)).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
    expect((await list()).find((staff) => staff.id === person.id)?.disabledAt).toBe(clock.now());
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)?.disabledAt).toBe(
      clock.now(),
    );
    expect((await send('PATCH', itemPath(person.id), { disabled: false })).status).toBe(200);
    await expect(pinAttempt(person.id, person.pin, live.id)).resolves.toBeUndefined();
    expect((await binding(live.id))?.staff_id).toBeNull();
  });

  it.each(['pin_reset', 'disable'] as const)(
    'rolls back credential/state and all unbindings if the %s audit insert fails',
    async (action) => {
      const person = await makeScanStaff(f, { orgId, pin: '482913' });
      const live = await makeScanner(f, { orgId, staffId: person.id });
      const test = await makeScanner(f, { orgId, mode: 'test', staffId: person.id });
      const oldCredential = await credential(person.id);
      const oldBindings = [await binding(live.id), await binding(test.id)];
      await run(
        env.DB,
        `CREATE TRIGGER fail_staff_admin_audit BEFORE INSERT ON audit_log
         WHEN NEW.action = 'scan_staff.${action}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
      );
      try {
        const res =
          action === 'disable'
            ? await send('PATCH', itemPath(person.id), { disabled: true })
            : await send('POST', resetPath(person.id));
        expect(res.status).toBe(500);
      } finally {
        await run(env.DB, 'DROP TRIGGER fail_staff_admin_audit');
      }
      expect(await credential(person.id)).toEqual(oldCredential);
      expect([await binding(live.id), await binding(test.id)]).toEqual(oldBindings);
      expect(
        await all(env.DB, 'SELECT action FROM audit_log WHERE target_id = ?', [person.id]),
      ).toEqual([]);
    },
  );

  it('audits each successful action by actor and target without names, PINs or hashes', async () => {
    const made = await create('Sensitive Original', 'door');
    const id = made.staff.id;
    expect(
      (await send('PATCH', itemPath(id), { name: 'Sensitive Changed', role: 'manager' })).status,
    ).toBe(200);
    const reset = await send('POST', resetPath(id));
    expect(reset.status).toBe(200);
    const replacement = StaffPinSchema.strict().parse(await reset.json());
    expect((await send('PATCH', itemPath(id), { disabled: true })).status).toBe(200);
    expect((await send('PATCH', itemPath(id), { disabled: false })).status).toBe(200);
    const rows = await all<{
      org_id: string;
      actor_type: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      detail: string | null;
    }>(env.DB, 'SELECT * FROM audit_log WHERE target_id = ? ORDER BY id', [id]);
    expect(rows.map((row) => row.action)).toEqual([
      'scan_staff.create',
      'scan_staff.update',
      'scan_staff.pin_reset',
      'scan_staff.disable',
      'scan_staff.enable',
    ]);
    const stored = await credential(id);
    if (!stored) throw new Error('Staff credential missing');
    const secrets = [
      'Sensitive Original',
      'Sensitive Changed',
      made.pin,
      replacement.pin,
      await hashPin(env, id, made.pin),
      stored.pin_hash,
    ];
    for (const row of rows) {
      expect(row).toMatchObject({
        org_id: orgId,
        actor_type: 'user',
        actor_id: userId,
        target_type: 'scan_staff',
        target_id: id,
      });
      const detail = row.detail ?? '';
      for (const secret of secrets) {
        expect(Object.values(row)).not.toContain(secret);
        expect(detail).not.toContain(secret);
      }
    }
  });
});
