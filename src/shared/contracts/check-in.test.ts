import { describe, expect, it } from 'vitest';
import { CheckInPolicySchema, CheckInStateSchema, PutMemberPhotoSchema } from './check-in.ts';
import { ScanAdminScopeSchema, ScannerSettingsSchema } from './scan.ts';

describe('configurable check-in contracts', () => {
  it.each(['single', 'daily', 'unlimited', 'in_out'])(
    'accepts %s with date and duration bounds',
    (mode) => {
      expect(
        CheckInPolicySchema.parse({ mode, validFrom: 100, validUntil: 200, durationMinutes: 60 }),
      ).toMatchObject({ mode, durationMinutes: 60 });
    },
  );
  it('keeps omitted overrides distinct from cleared date limits', () => {
    expect(CheckInPolicySchema.parse({})).toEqual({});
    expect(CheckInPolicySchema.parse({ validUntil: null })).toEqual({ validUntil: null });
  });
  it.each([
    { validFrom: 200, validUntil: 100 },
    { durationMinutes: 0 },
    { durationMinutes: 1.5 },
    { mode: 'unknown' },
    { arbitrary: true },
  ])('rejects invalid rules %j', (rules) => {
    expect(CheckInPolicySchema.safeParse(rules).success).toBe(false);
  });
  it('requires explicit photo inclusion in the distributed pass', () => {
    expect(PutMemberPhotoSchema.parse({ png: 'fixture' }).includeInPass).toBe(false);
  });
  it('represents an exit without treating it as another entry', () => {
    expect(
      CheckInStateSchema.parse({
        mode: 'in_out',
        direction: 'out',
        inside: false,
        enteredAt: null,
        firstAt: 100,
        validFrom: null,
        validUntil: null,
      }).direction,
    ).toBe('out');
  });
  it('adds optional setup scope and scanner rules without changing legacy settings', () => {
    const settings = {
      flow: 'auto',
      defaultActionId: null,
      roleWithoutSignIn: 'door',
      staffSignIn: false,
      letInAgain: 'never',
      reader: 'none',
      lookup: true,
      offline: false,
      dailyAmount: null,
    };
    expect(ScannerSettingsSchema.parse(settings)).toEqual(settings);
    expect(
      ScannerSettingsSchema.parse({ ...settings, direction: 'both', checkIn: { mode: 'in_out' } })
        .checkIn?.mode,
    ).toBe('in_out');
    expect(
      ScanAdminScopeSchema.parse({ orgId: 'org', timeZone: 'UTC', setupId: 'setup' }).setupId,
    ).toBe('setup');
  });
});
