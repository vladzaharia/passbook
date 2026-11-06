import { describe, expect, it } from 'vitest';
import {
  AdminScannerStartedSchema,
  CreateScannerSetupSchema,
  ScanLiveRowSchema,
  ScanWatchSchema,
} from './scan-setups.ts';

describe('managed scanner setup contracts', () => {
  it('supports scanner, customer and monitor views with the same pairing model', () => {
    for (const deviceRole of ['scan', 'customer', 'monitor']) {
      expect(
        CreateScannerSetupSchema.parse({ orgId: 'org', name: 'Desk', timeZone: 'UTC', deviceRole })
          .deviceRole,
      ).toBe(deviceRole);
    }
  });
  it('represents a user/org admin setup independently of device credentials', () => {
    expect(
      AdminScannerStartedSchema.parse({
        setupId: 'setup',
        orgId: 'org',
        mode: 'live',
        timeZone: 'UTC',
      }),
    ).toMatchObject({ setupId: 'setup', orgId: 'org' });
  });
  it('bounds explicitly selected source devices', () => {
    expect(ScanWatchSchema.parse({ scannerIds: ['a', 'b'] })).toEqual({
      scannerIds: ['a', 'b'],
      allOrg: false,
    });
    expect(
      ScanWatchSchema.safeParse({ scannerIds: Array.from({ length: 9 }, (_, i) => `s${i}`) })
        .success,
    ).toBe(false);
  });
  it('distinguishes a presented pass from a private lookup', () => {
    const row = {
      id: 'scan',
      at: 100,
      scannerId: 'scanner',
      scannerName: 'Door',
      passId: null,
      holder: null,
      photoUrl: null,
      kind: 'ok',
      direction: 'in',
      label: 'Checked in',
      presented: false,
    };
    expect(ScanLiveRowSchema.parse(row).presented).toBe(false);
  });
});
