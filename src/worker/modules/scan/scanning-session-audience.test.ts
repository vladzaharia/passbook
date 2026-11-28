import { describe, expect, it } from 'vitest';
import { audienceOf } from '../../../shared/scan-defaults.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { effectiveSessionSettings } from './scanning-session-dto.ts';

const session = {
  settings: JSON.stringify({
    flow: 'auto',
    defaultActionId: null,
    roleWithoutSignIn: 'door',
    staffSignIn: false,
    letInAgain: 'manager',
    reader: 'barcode',
    lookup: false,
    offline: false,
    dailyAmount: null,
  }),
} as ScanningSessionRow;
const device = (overrides: object) =>
  ({ overrides: JSON.stringify(overrides) }) as unknown as ScanningDeviceRow;

describe('monitor audience inside a session', () => {
  it('a device override opens names on that Monitor only', () => {
    const backOffice = effectiveSessionSettings(session, device({ monitorAudience: 'staff' }));
    const lobby = effectiveSessionSettings(session, device({}));
    expect(audienceOf(backOffice)).toBe('staff');
    expect(audienceOf(lobby)).toBe('public');
  });

  it('a device override carries the appearance', () => {
    expect(effectiveSessionSettings(session, device({ appearance: 'dark' }))?.appearance).toBe(
      'dark',
    );
  });
});
