import { describe, expect, it } from 'vitest';
import { NfcStatusSchema, VasKeySchema } from './nfc.ts';
import {
  ScanActRequestSchema,
  ScanAdminScopeSchema,
  ScanOutcomeSchema,
  ScanSessionSchema,
  TimeZoneSchema,
  UuidV7Schema,
} from './scan.ts';
import {
  CreateScanEventSchema,
  CreateScannerSchema,
  ScanEventSchema,
  ScannerSchema,
} from './scanners.ts';

const id = '01900000-0000-7000-8000-000000000001';
const key = '01900000-0000-7000-8000-0000000000aa';
const counts = { today: 3, event: null, asOf: 1, configRev: 2 };
const settings = {
  flow: 'auto',
  defaultActionId: null,
  roleWithoutSignIn: 'door',
  staffSignIn: false,
  letInAgain: 'manager',
  reader: 'none',
  lookup: true,
  offline: false,
  dailyAmount: null,
} as const;

const outcome = {
  scanId: id,
  kind: 'refused',
  reason: 'not_found',
  replay: false,
  action: null,
  card: null,
  previous: null,
  template: null,
  at: 5,
  cooldownRemainingMs: null,
  value: null,
  flags: [],
  overridable: false,
  approvals: false,
  group: null,
  counts,
  milestone: null,
  undoUntil: null,
  display: null,
};

describe('scan contracts', () => {
  it('round trips an outcome, with and without a milestone', () => {
    expect(ScanOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(ScanOutcomeSchema.parse({ ...outcome, milestone: 'reward' }).milestone).toBe('reward');
    expect(ScanOutcomeSchema.safeParse({ ...outcome, milestone: 'party' }).success).toBe(false);
  });

  it('round trips a session', () => {
    const session = {
      principal: 'scanner',
      state: 'ready',
      scanner: {
        id,
        name: 'Front door',
        kind: 'device',
        mode: 'live',
        orgId: id,
        orgName: 'Northwind',
        timeZone: 'Europe/Berlin',
        settings,
      },
      admin: null,
      event: {
        id,
        name: 'Gala',
        opensAt: 1,
        closesAt: 2,
        timeZone: 'UTC',
        reentry: false,
        note: 'Check ID.',
      },
      templates: [],
      formats: ['qr'],
      staff: null,
      staffList: null,
      approvals: false,
      csrfToken: 'x',
      undoWindowMinutes: 10,
      counts,
    };
    expect(ScanSessionSchema.parse(session)).toEqual(session);
    expect(
      ScanSessionSchema.safeParse({
        ...session,
        event: { ...session.event, note: 'x'.repeat(141) },
      }).success,
    ).toBe(false);
  });

  it('round trips the console shapes', () => {
    const scanner = {
      id,
      orgId: id,
      mode: 'live',
      kind: 'device',
      name: 'Door',
      accepts: { eventId: id },
      settings,
      timeZone: 'UTC',
      status: 'paired',
      online: true,
      pairedAt: 1,
      pairedLabel: 'iPhone',
      lastSeenAt: 2,
      expiresAt: null,
      staff: null,
      today: 4,
      createdAt: 1,
    };
    expect(ScannerSchema.parse(scanner)).toEqual(scanner);
    const event = {
      id,
      orgId: id,
      mode: 'live',
      name: 'Gala',
      templateIds: [id],
      match: null,
      opensAt: 1,
      closesAt: 2,
      timeZone: 'UTC',
      capacity: 500,
      reentry: false,
      note: 'Info',
      status: 'live',
      arrived: 1,
      expected: 2,
      scanners: 1,
    };
    expect(ScanEventSchema.parse(event)).toEqual(event);
    const vas = {
      id,
      identityId: id,
      orgId: id,
      keyId: 'abcdef01',
      state: 'active',
      createdAt: 1,
      activatedAt: 1,
      retiredAt: null,
      passCount: 0,
      passesLeft: null,
    };
    expect(VasKeySchema.parse(vas)).toEqual(vas);
    expect(
      NfcStatusSchema.parse({
        enabled: false,
        identities: [{ id, label: 'Platform', nfcEnabled: false, keys: [vas] }],
      }).enabled,
    ).toBe(false);
  });

  it('keeps an event note to 140 characters and a window forward', () => {
    const create = {
      orgId: id,
      name: 'Gala',
      templateIds: [id],
      opensAt: 1,
      closesAt: 2,
      timeZone: 'UTC',
    };
    expect(CreateScanEventSchema.safeParse({ ...create, note: 'x'.repeat(140) }).success).toBe(
      true,
    );
    expect(CreateScanEventSchema.safeParse({ ...create, note: 'x'.repeat(141) }).success).toBe(
      false,
    );
    expect(CreateScanEventSchema.safeParse({ ...create, closesAt: 1 }).success).toBe(false);
  });

  it('validates a scanner create body', () => {
    const body = {
      orgId: id,
      name: 'Door',
      kind: 'terminal',
      accepts: { templateIds: [id] },
      timeZone: 'UTC',
    };
    expect(CreateScannerSchema.safeParse(body).success).toBe(true);
    expect(CreateScannerSchema.safeParse({ ...body, accepts: { templateIds: [] } }).success).toBe(
      false,
    );
  });
});

describe('requests', () => {
  const act = {
    idempotencyKey: key,
    input: { code: 'abc', method: 'camera' },
    clientTs: 1,
    actionId: 'auto',
  };
  it('accepts a minimal act', () => {
    expect(ScanActRequestSchema.safeParse(act).success).toBe(true);
    expect(
      ScanActRequestSchema.safeParse({ ...act, input: { passId: id, method: 'manual' } }).success,
    ).toBe(true);
  });
  it('rejects an unknown key', () => {
    expect(ScanActRequestSchema.safeParse({ ...act, extra: 1 }).success).toBe(false);
  });
  it('rejects a non UUIDv7 key', () => {
    expect(UuidV7Schema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(false);
    expect(UuidV7Schema.safeParse(key).success).toBe(true);
  });
  it('checks time zones with Intl', () => {
    expect(TimeZoneSchema.safeParse('Europe/Berlin').success).toBe(true);
    expect(TimeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
    expect(ScanAdminScopeSchema.safeParse({ orgId: id, timeZone: 'nope' }).success).toBe(false);
  });
});
