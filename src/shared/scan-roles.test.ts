import { describe, expect, it } from 'vitest';
import { isKioskRole, isScreenRole, isStaffDeviceRole } from './scan-roles.ts';

describe('scan roles', () => {
  it('puts each role in exactly one class', () => {
    expect(
      ['scan', 'customer', 'monitor', 'kiosk'].map(
        (r) =>
          [
            isStaffDeviceRole(r as 'scan'),
            isScreenRole(r as 'scan'),
            isKioskRole(r as 'scan'),
          ].filter(Boolean).length,
      ),
    ).toEqual([1, 1, 1, 1]);
    expect(isScreenRole('kiosk')).toBe(false);
  });
});
