import { describe, expect, it } from 'vitest';
import { surfaceFor } from '../scan-surfaces.ts';
import { CreateScanningDeviceSchema } from './scanning-sessions.ts';

const caps = { width: 1200, preferred: 'operator' } as never;

describe('Staff device contract', () => {
  it('creates a Staff device by default and screens without staff fields', () => {
    expect(CreateScanningDeviceSchema.parse({ name: 'Door' }).deviceRole).toBe('scan');
    expect(CreateScanningDeviceSchema.safeParse({ deviceRole: 'customer' }).success).toBe(true);
    expect(
      CreateScanningDeviceSchema.safeParse({ deviceRole: 'customer', surface: 'phone' }).success,
    ).toBe(false);
    expect(
      CreateScanningDeviceSchema.safeParse({ deviceRole: 'monitor', ownership: 'shared' }).success,
    ).toBe(false);
  });

  it('accepts only the scan layouts and no kiosk yet', () => {
    expect(CreateScanningDeviceSchema.safeParse({ surface: 'customer' }).success).toBe(false);
    expect(CreateScanningDeviceSchema.safeParse({ surface: 'desk' }).success).toBe(false);
    expect(CreateScanningDeviceSchema.safeParse({ deviceRole: 'kiosk' }).success).toBe(false);
  });

  it('needs a person on a Personal device and none on a Shared one', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(CreateScanningDeviceSchema.safeParse({ ownership: 'personal' }).success).toBe(false);
    expect(
      CreateScanningDeviceSchema.safeParse({ ownership: 'personal', personalStaffId: id }).success,
    ).toBe(true);
    expect(
      CreateScanningDeviceSchema.safeParse({ ownership: 'shared', personalStaffId: id }).success,
    ).toBe(false);
  });

  it('resolves auto only among the allowed layouts', () => {
    expect(surfaceFor('auto', caps)).toBe('operator');
    expect(surfaceFor('auto', caps, ['phone'])).toBe('phone');
    expect(surfaceFor('phone', caps)).toBe('phone');
  });
});
