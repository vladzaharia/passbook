import { describe, expect, it } from 'vitest';
import {
  AdminScannerStartedSchema,
  CreateScannerSetupSchema,
  ScanLiveResolvedSchema,
  ScanLiveRowSchema,
  ScanLiveSnapshotSchema,
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
  it('adds watch targets without changing an old watch', () => {
    expect(ScanWatchSchema.parse({})).toEqual({ scannerIds: [], allOrg: false });
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
    expect(
      ScanWatchSchema.parse({ sessionIds: ['s1'], eventId: 'e1', zoneIds: ['z1'] }),
    ).toMatchObject({ sessionIds: ['s1'], eventId: 'e1', zoneIds: ['z1'] });
    expect(ScanWatchSchema.safeParse({ sessionIds: ids(9) }).success).toBe(false);
    expect(ScanWatchSchema.safeParse({ zoneIds: ids(9) }).success).toBe(false);
    expect(ScanWatchSchema.safeParse({ stationId: 's' }).success).toBe(false);
  });
  it('carries occupancy, places, overrides and replaces on a live row', () => {
    const row = {
      id: 'scan',
      at: 100,
      scannerId: 'scanner',
      scannerName: 'Door',
      passId: null,
      holder: null,
      photoUrl: null,
      kind: 'ok',
      direction: 'out',
      label: 'Tapped out',
      presented: true,
    };
    expect(ScanLiveRowSchema.parse(row)).toEqual(row);
    const rev = { place: 'zone:z1', name: 'Pool', inNow: 3, capacity: 25, rev: 4 };
    const full = {
      ...row,
      outCause: 'desk',
      places: [rev],
      overrideOf: 'scan0',
      resolvedBy: { staff: 'Ana R.', device: 'Office iPad' },
      replaces: '01900000-0000-7000-8000-0000000000aa',
    };
    expect(ScanLiveRowSchema.parse(full)).toMatchObject({ places: [rev], overrideOf: 'scan0' });
    expect(ScanLiveRowSchema.safeParse({ ...full, outCause: 'bored' }).success).toBe(false);
    expect(ScanLiveRowSchema.safeParse({ ...full, replaces: 'not-a-key' }).success).toBe(false);
    expect(ScanLiveSnapshotSchema.parse({ cursor: null, rows: [] })).toEqual({
      cursor: null,
      rows: [],
    });
    expect(
      ScanLiveResolvedSchema.safeParse({
        of: 'scan',
        outcome: 'ok',
        by: { staff: null, device: 'd' },
      }).success,
    ).toBe(true);
    expect(ScanLiveResolvedSchema.safeParse({ of: 'scan', outcome: 'ok' }).success).toBe(false);
  });
});
