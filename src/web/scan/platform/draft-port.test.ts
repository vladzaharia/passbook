import { describe, expect, it } from 'vitest';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { draftPortOf } from './draft-port.ts';

const api = {} as ScanApi;

describe('draft port', () => {
  it('is for a paired scan device only', () => {
    const base = sessionFixture();
    const scanner = (deviceRole: 'scan' | 'customer') =>
      base.scanner ? { ...base.scanner, deviceRole } : null;
    expect(
      draftPortOf({ ...base, principal: 'scanner', scanner: scanner('scan') }, api),
    ).toBeDefined();
    expect(
      draftPortOf({ ...base, principal: 'admin', scanner: scanner('scan') }, api),
    ).toBeUndefined();
    expect(
      draftPortOf({ ...base, principal: 'scanner', scanner: scanner('customer') }, api),
    ).toBeUndefined();
  });
});
