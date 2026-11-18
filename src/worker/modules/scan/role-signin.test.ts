import { describe, expect, it, vi } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { ConflictError } from '../../platform/errors.ts';
import { getScanner } from './repo-device.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

vi.mock('./repo-device.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repo-device.ts')>()),
  bindStaff: vi.fn(async () => {
    throw new ConflictError('changed', 'SCAN_STAFF_CHANGED');
  }),
}));

describe('device flip: sign-in after unlock', () => {
  it('stays on scan with the plain sign-in when the second step is refused', async () => {
    const f = staffSessionFixture();
    await f.setup();
    const staff = await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '805217' });
    const scanner = await f.kit.scanner({
      templateIds: [f.deskTemplate],
      settings: { staffSignIn: true },
    });
    await f.call('POST', '/scan/role', scanner.headers, { role: 'customer' });
    const res = await f.call('POST', '/scan/role', scanner.headers, {
      role: 'scan',
      unlock: { pin: staff.pin },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'staff_required',
      staff: null,
      scanner: { deviceRole: 'scan' },
    });
    const row = await getScanner(f.kit.env.DB, scanner.id);
    expect(row).toMatchObject({ deviceRole: 'scan', staffId: null });
  });
});
