import { describe, expect, it } from 'vitest';
import { makeOrg, makeScanStaff, type StaffFixture } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { setupScanKit } from './test-kit.ts';

describe('paired scanner staff roster', () => {
  it('lists every enabled same-org staff member and signs in the 201st', async () => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
    });
    const foreignOrg = await makeOrg(kit.fx);
    const staff: StaffFixture[] = [];
    // Insert in reverse order so the expected roster also verifies ordering by name.
    for (let number = 201; number >= 1; number--) {
      staff.push(
        await makeScanStaff(kit.fx, {
          orgId: kit.org.id,
          name: `Staff ${String(number).padStart(3, '0')}`,
          pin: number === 201 ? '682731' : '123456',
        }),
      );
    }
    const last = staff[0];
    if (!last) throw new Error('Missing staff member 201');
    await makeScanStaff(kit.fx, { orgId: kit.org.id, name: 'Staff 000 Disabled', disabled: true });
    await makeScanStaff(kit.fx, { orgId: foreignOrg.id, name: 'Staff 000 Foreign' });
    const expected = staff.reverse().map(({ id, name, role }) => ({ id, name, role }));

    const response = await kit.get(scanner.headers, '/session');
    expect(response.status).toBe(200);
    const session = ScanSessionSchema.parse(await response.json());
    expect(session).toMatchObject({ principal: 'scanner', state: 'staff_required', staff: null });
    expect(session.staffList).toEqual(expected);
    expect(session.staffList).toHaveLength(201);

    const signIn = await kit.post(scanner.headers, '/staff', { staffId: last.id, pin: last.pin });
    expect(signIn.status).toBe(200);
    const signedIn = ScanSessionSchema.parse(await signIn.json());
    expect(signedIn.staff).toEqual({ id: last.id, name: last.name, role: last.role });
    expect(signedIn.staffList).toEqual(expected);

    const after = await kit.get(scanner.headers, '/session');
    expect(after.status).toBe(200);
    const reloaded = ScanSessionSchema.parse(await after.json());
    expect(reloaded.staff).toEqual({ id: last.id, name: last.name, role: last.role });
    expect(reloaded.staffList).toEqual(expected);
  });
});
