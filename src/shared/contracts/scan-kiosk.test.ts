import { describe, expect, it } from 'vitest';
import { KIOSK_COPY } from '../copy/scan-kiosk.ts';
import { GuestCodeInputSchema, normalizeGuestCode } from './guest-codes.ts';
import { ScanActRequestSchema } from './scan.ts';
import { AgreementAcceptanceInputSchema } from './scan-agreements.ts';
import {
  ScanHelpRaiseResponseSchema,
  ScanHelpRaiseSchema,
  ScanHelpRequestSchema,
} from './scan-help.ts';
import { KioskHostResultSchema, ScanHostCreateSchema } from './scan-hosts.ts';
import {
  KioskConfigSchema,
  KioskDeviceSettingsSchema,
  KioskHeartbeatSchema,
  KioskPatchSchema,
  KioskViewSchema,
  KioskWalkInSchema,
} from './scan-kiosk.ts';
import {
  KIOSK_ALLOWED_ENDPOINTS,
  KioskBatchRequestSchema,
  KioskBatchResultSchema,
  KioskHelpRaiseSchema,
  KioskHelpViewSchema,
  KioskLiveSnapshotSchema,
  KioskRosterSchema,
  KioskScanSchema,
  KioskStaffLookupResultSchema,
} from './scan-kiosk-api.ts';
import {
  ScanBatchRequestSchema,
  ScanBatchResultSchema,
  ScanLookupResultSchema,
  ScanRosterSchema,
} from './scan-session.ts';

const settings = {
  entries: { pass: true, findMe: false, code: false, walkIn: false, leaving: false },
  findMeKinds: [],
  direction: 'in',
  hours: null,
  staffedHours: null,
  idle: { warnS: 20, resetS: 30 },
  help: { unstaffedText: 'Ask at the desk' },
  walkIn: null,
  kioskExitRole: 'desk',
  kioskOverrideRole: 'door',
  network: { cidrs: [] },
  signatureRetentionDays: null,
  presetId: null,
};
const week = { mon: ['09:00-17:00'] };
const config = {
  name: 'Kiosk 1',
  mode: 'live',
  timeZone: 'America/Los_Angeles',
  configEpoch: 3,
  entries: { pass: true, findMe: true, code: true, walkIn: true, leaving: false },
  findMeKinds: ['name_phone', 'email'],
  direction: 'in',
  hours: week,
  staffedHours: null,
  idle: { warnS: 20, resetS: 30 },
  help: { unstaffedText: 'Call (206) 555-0142' },
  walkIn: {
    fields: [
      { key: 'firstName', required: true },
      { key: 'email', required: true },
    ],
    handoff: 'both',
    agreements: [
      {
        agreementId: 'a1',
        versionId: 'v1',
        kind: 'waiver',
        title: 'Waiver',
        body: 'Words.',
        minors: 'guardian',
      },
    ],
  },
  hostPicker: true,
  helpConnected: false,
  nfcReader: { use: false, model: 'any', connection: 'auto' },
  readerEpoch: 0,
};

/** Every path the projection may carry. A new field fails this test until a reviewer adds it here. */
const ALLOWED = new Set([
  'name',
  'mode',
  'timeZone',
  'configEpoch',
  'entries',
  'entries.pass',
  'entries.findMe',
  'entries.code',
  'entries.walkIn',
  'entries.leaving',
  'findMeKinds',
  'findMeKinds[]',
  'direction',
  'hours',
  'hours.mon',
  'hours.mon[]',
  'staffedHours',
  'idle',
  'idle.warnS',
  'idle.resetS',
  'help',
  'help.unstaffedText',
  'walkIn',
  'walkIn.fields',
  'walkIn.fields[]',
  'walkIn.fields[].key',
  'walkIn.fields[].required',
  'walkIn.handoff',
  'walkIn.agreements',
  'walkIn.agreements[]',
  'walkIn.agreements[].agreementId',
  'walkIn.agreements[].versionId',
  'walkIn.agreements[].kind',
  'walkIn.agreements[].title',
  'walkIn.agreements[].body',
  'walkIn.agreements[].minors',
  'hostPicker',
  'helpConnected',
  'nfcReader',
  'nfcReader.use',
  'nfcReader.model',
  'nfcReader.connection',
  'readerEpoch',
]);

function paths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value))
    return [`${prefix}[]`, ...value.flatMap((v) => paths(v, `${prefix}[]`))];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...paths(v, p)];
    });
  }
  return [];
}
const strays = (c: unknown) => paths(c).filter((p) => !ALLOWED.has(p));

describe('KioskConfigSchema, the privacy boundary', () => {
  it('parses a projection whose every path is on the allow-list', () => {
    const parsed = KioskConfigSchema.parse(config);
    expect(strays(parsed)).toEqual([]);
    expect(paths(parsed).filter((p) => !p.includes('[]') || ALLOWED.has(p))).not.toHaveLength(0);
  });
  it.each([
    ['a staff name', { staffName: 'Sam Rivera' }],
    ['a reason code', { reason: 'capacity_full' }],
    ['a member email', { email: 'a@b.co' }],
    ['the CIDR list', { network: { cidrs: ['10.0.0.0/8'] } }],
    ['the roles', { kioskExitRole: 'desk' }],
    ['the retention', { signatureRetentionDays: 30 }],
    ['the template id', { templateId: 't1' }],
  ])('refuses %s', (_label, extra) => {
    expect(KioskConfigSchema.safeParse({ ...config, ...extra }).success).toBe(false);
    expect(strays({ ...config, ...extra })).not.toEqual([]);
  });
  it('refuses an extra field nested in the walk-in or an agreement', () => {
    const agreement = { ...config.walkIn.agreements[0], acceptedBy: 'Sam' };
    expect(
      KioskConfigSchema.safeParse({
        ...config,
        walkIn: { ...config.walkIn, agreements: [agreement] },
      }).success,
    ).toBe(false);
    expect(
      KioskConfigSchema.safeParse({ ...config, walkIn: { ...config.walkIn, templateId: 't' } })
        .success,
    ).toBe(false);
  });
});

describe('KioskViewSchema', () => {
  it('takes the shown fields only', () => {
    expect(
      KioskViewSchema.safeParse({
        screen: 'welcome',
        greet: 'Dana',
        card: { band: 'in' },
      }).success,
    ).toBe(true);
    for (const extra of [{ reason: 'expired' }, { passId: 'p' }, { count: 4 }, { staff: 'Sam' }]) {
      expect(KioskViewSchema.safeParse({ screen: 'see_desk', ...extra }).success).toBe(false);
    }
  });
  it('shows at most 4 rows and no sub', () => {
    const row = { handle: 'h', firstName: 'Dana', serialTail: '42' };
    expect(KioskViewSchema.safeParse({ screen: 'choose', rows: Array(5).fill(row) }).success).toBe(
      false,
    );
    expect(KioskViewSchema.safeParse({ screen: 'choose', rows: [row] }).success).toBe(true);
    expect(KioskViewSchema.safeParse({ screen: 'see_desk', sub: 'capacity_full' }).success).toBe(
      false,
    );
    expect(KioskViewSchema.safeParse({ screen: 'see_desk', subWhen: '6 PM' }).success).toBe(false);
  });
  it('carries no free text: serial, host, email and handoff are constrained', () => {
    const row = { handle: 'h', firstName: 'Dana' };
    const bad = [
      { screen: 'choose', rows: [{ ...row, serialTail: 'ab' }] },
      { screen: 'choose', rows: [{ ...row, hint: 'Pass ••42', serialTail: '42' }] },
      { screen: 'code', hostName: 'a\nb' },
      { screen: 'welcome', maskedEmail: 'anna@gmail.com' },
      { screen: 'welcome', card: { label: 'Dana Smith', band: 'in' } },
      { screen: 'welcome', handoff: { id: 'h', url: 'javascript:1', expiresAt: 1 } },
      { screen: 'welcome', handoff: { url: 'https://x.test/h/t', expiresAt: 1 } },
    ];
    for (const view of bad) expect(KioskViewSchema.safeParse(view).success).toBe(false);
    const good = {
      screen: 'welcome',
      hostName: 'Sam',
      maskedEmail: 'a•••@g•••.com',
      card: { band: 'in' },
      handoff: { id: 'h1', url: 'https://x.test/h/t', expiresAt: 1 },
    };
    expect(KioskViewSchema.safeParse(good).success).toBe(true);
  });
  it('has no sub copy and the help lines follow K-D20', () => {
    expect(JSON.stringify(KIOSK_COPY)).not.toContain('Your plan opens');
    expect(KIOSK_COPY.help.coming).toBe("Someone's coming.");
    expect('call' in KIOSK_COPY.help).toBe(false);
  });
});

describe('kiosk request and response schemas', () => {
  it('scan takes camera, hid or nfc only', () => {
    expect(KioskScanSchema.safeParse({ code: 'x', method: 'hid' }).success).toBe(true);
    expect(KioskScanSchema.safeParse({ code: 'x', method: 'manual' }).success).toBe(false);
    expect(KioskScanSchema.safeParse({ code: 'x', method: 'nfc', passId: 'p' }).success).toBe(
      false,
    );
  });
  it('help raise is a kiosk topic and nothing else', () => {
    expect(
      KioskHelpRaiseSchema.safeParse({ topic: 'kiosk_help', idempotencyKey: 'k' }).success,
    ).toBe(true);
    expect(
      KioskHelpRaiseSchema.safeParse({ topic: 'kiosk_admit', scanId: 's', idempotencyKey: 'k' })
        .success,
    ).toBe(true);
    for (const body of [
      { topic: 'act', idempotencyKey: 'k' },
      { topic: 'kiosk_admit', idempotencyKey: 'k' },
      { topic: 'kiosk_help', idempotencyKey: 'k', act: { code: 'x', method: 'manual' } },
      { topic: 'kiosk_admit', scanId: 's', passId: 'p', idempotencyKey: 'k' },
    ])
      expect(KioskHelpRaiseSchema.safeParse(body).success).toBe(false);
  });
  it('help view has no ids of staff, pass, reason or responders', () => {
    const view = { id: 'h', state: 'open', expiresAt: 1, onTheWay: false };
    expect(KioskHelpViewSchema.safeParse(view).success).toBe(true);
    for (const extra of [
      { passId: 'p' },
      { reasonCode: 'r' },
      { responders: 2 },
      { denyReason: 'x' },
    ])
      expect(KioskHelpViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
  });
  it('email is validated and normalized', () => {
    const detail = { firstName: 'Dana', lastName: 'Lee', email: ' Dana@Example.COM ' };
    const walk = { details: detail, acceptances: [], idempotencyKey: 'abcdefgh' };
    expect(KioskWalkInSchema.parse(walk).details.email).toBe('dana@example.com');
    expect(
      KioskWalkInSchema.safeParse({ ...walk, details: { ...detail, email: 'nope' } }).success,
    ).toBe(false);
  });
  it('staff lookup returns handles and initials only', () => {
    const item = { handle: 'h', firstName: 'Dana', lastInitial: 'L', serialTail: '42' };
    expect(KioskStaffLookupResultSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(
      KioskStaffLookupResultSchema.safeParse({ items: [{ ...item, email: 'a@b.co' }] }).success,
    ).toBe(false);
  });
  it('batch and roster are strict', () => {
    const item = {
      idempotencyKey: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      code: 'x',
      method: 'nfc',
      clientTs: 1,
    };
    expect(KioskBatchRequestSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(
      KioskBatchRequestSchema.safeParse({ items: [{ ...item, override: true }] }).success,
    ).toBe(false);
    expect(
      KioskBatchRequestSchema.safeParse({ items: [{ ...item, method: 'manual' }] }).success,
    ).toBe(false);
    expect(
      KioskBatchResultSchema.safeParse({
        items: [{ idempotencyKey: item.idempotencyKey, synced: true, outcome: 'ok' }],
      }).success,
    ).toBe(false);
    const entry = { h: 'a'.repeat(32), status: 'active', state: null };
    const roster = { entries: [entry], cursor: null, asOf: 1, validUntil: 2 };
    expect(KioskRosterSchema.safeParse(roster).success).toBe(true);
    expect(
      KioskRosterSchema.safeParse({ ...roster, entries: [{ ...entry, g: '1' }] }).success,
    ).toBe(false);
  });
});

describe('KioskPatchSchema', () => {
  it('leaves nfcReader alone when the PATCH omits it', () => {
    const parsed = KioskPatchSchema.parse({ kiosk: { direction: 'both' } });
    expect(parsed.kiosk).toEqual({ direction: 'both' });
    expect('nfcReader' in parsed.kiosk).toBe(false);
  });
  it('still validates nfcReader when sent', () => {
    expect(
      KioskPatchSchema.parse({
        kiosk: { nfcReader: { use: true, model: 'any', connection: 'auto' } },
      }).kiosk.nfcReader?.use,
    ).toBe(true);
    expect(KioskPatchSchema.safeParse({ kiosk: { nfcReader: { use: 'yes' } } }).success).toBe(
      false,
    );
  });
});

/** A new field or route fails here until a reviewer updates the snapshot on purpose. */
describe('kiosk shape snapshots', () => {
  const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();
  it('view, config, help and device bodies keep their keys', () => {
    expect(keys(KioskViewSchema)).toEqual([
      'card',
      'greet',
      'handoff',
      'hostName',
      'hostNotified',
      'maskedEmail',
      'reward',
      'room',
      'rows',
      'screen',
    ]);
    expect(keys(KioskConfigSchema)).toEqual([
      'configEpoch',
      'direction',
      'entries',
      'findMeKinds',
      'help',
      'helpConnected',
      'hostPicker',
      'hours',
      'idle',
      'mode',
      'name',
      'nfcReader',
      'readerEpoch',
      'staffedHours',
      'timeZone',
      'walkIn',
    ]);
    expect(keys(KioskHelpViewSchema)).toEqual(['expiresAt', 'handle', 'id', 'onTheWay', 'state']);
    expect(keys(KioskScanSchema)).toEqual(['code', 'method']);
    expect(keys(KioskStaffLookupResultSchema)).toEqual(['items']);
    expect(keys(KioskRosterSchema)).toEqual(['asOf', 'cursor', 'entries', 'sig', 'validUntil']);
    expect(keys(KioskLiveSnapshotSchema)).toEqual(['cursor', 'events']);
    expect(keys(KioskViewSchema.shape.rows.unwrap().element)).toEqual([
      'firstName',
      'handle',
      'serialTail',
    ]);
    expect(keys(KioskViewSchema.shape.handoff.unwrap())).toEqual(['expiresAt', 'id', 'url']);
  });
  it('the allow-list is exactly these routes, each on kiosk schemas', () => {
    expect(KIOSK_ALLOWED_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /scan/kiosk/config',
      'POST /scan/kiosk/heartbeat',
      'POST /scan',
      'POST /scan/kiosk/lookup',
      'POST /scan/kiosk/code',
      'POST /scan/kiosk/confirm',
      'GET /scan/kiosk/hosts',
      'POST /scan/kiosk/walk-in',
      'POST /scan/kiosk/handoff/{id}/revoke',
      'GET /scan/kiosk/roster',
      'POST /scan/kiosk/batch',
      'GET /scan/kiosk/live',
      'POST /staff/pin',
      'DELETE /staff',
      'POST /scan/kiosk/staff/lookup',
      'POST /scan/kiosk/staff/admit',
      'POST /scan/kiosk/staff/pause',
      'POST /scan/kiosk/staff/resume',
      'POST /scan/kiosk/staff/exit',
      'POST /scan/help',
      'POST /scan/help/{id}/cancel',
      'GET /scan/help/{id}',
    ]);
    const staff = [
      ScanActRequestSchema,
      ScanHelpRaiseSchema,
      ScanHelpRequestSchema,
      ScanHelpRaiseResponseSchema,
      ScanLookupResultSchema,
      ScanRosterSchema,
      ScanBatchRequestSchema,
      ScanBatchResultSchema,
    ];
    for (const e of KIOSK_ALLOWED_ENDPOINTS)
      for (const schema of [e.request, e.response]) if (schema) expect(staff).not.toContain(schema);
  });
});

describe('KioskHeartbeatSchema', () => {
  it('takes battery and the reader without reportedAt', () => {
    const reader = {
      state: 'ready',
      model: 'acr1555u',
      transport: 'bluetooth',
      pinned: true,
      pinnedBy: 'staffMenu',
      label: null,
      firmware: null,
      battery: { percent: 20, low: true, charging: false },
      code: null,
    };
    const body = {
      screen: 'home',
      camera: 'available',
      battery: { pct: 80, charging: true },
      nfcReader: reader,
    };
    expect(KioskHeartbeatSchema.safeParse(body).success).toBe(true);
    expect(
      KioskHeartbeatSchema.safeParse({ ...body, nfcReader: { ...reader, reportedAt: 1 } }).success,
    ).toBe(false);
    expect(KioskHeartbeatSchema.safeParse({ screen: 'locked', camera: 'unknown' }).success).toBe(
      true,
    );
  });
});

describe('kiosk endpoints and codes', () => {
  it('allows no reach, claim, list or device route', () => {
    const paths = KIOSK_ALLOWED_ENDPOINTS.map((e) => e.path);
    expect(paths.some((p) => p.startsWith('/scan/devices'))).toBe(false);
    expect(
      KIOSK_ALLOWED_ENDPOINTS.find((e) => e.method === 'GET' && e.path === '/scan/help'),
    ).toBeUndefined();
  });
  it('reads a guest code with look-alikes and spaces', () => {
    expect(normalizeGuestCode(' k7m-q0l ')).toBe('K7MQ01');
    expect(GuestCodeInputSchema.safeParse('k7m q0l').success).toBe(true);
    expect(GuestCodeInputSchema.safeParse('K7MQ').success).toBe(false);
    expect(GuestCodeInputSchema.safeParse('K7MQUU').success).toBe(false);
  });
});

describe('hosts and agreements', () => {
  it('sends the kiosk a host id and name, never an email, at most 5', () => {
    const host = { id: 'h1', displayName: 'Sam' };
    expect(KioskHostResultSchema.safeParse({ items: [host] }).success).toBe(true);
    expect(
      KioskHostResultSchema.safeParse({ items: [{ ...host, email: 'sam@b.co' }] }).success,
    ).toBe(false);
    expect(KioskHostResultSchema.safeParse({ items: Array(6).fill(host) }).success).toBe(false);
    expect(ScanHostCreateSchema.parse({ displayName: 'Sam', email: 'Sam@B.co' })).toMatchObject({
      email: 'sam@b.co',
      notify: true,
    });
  });
  it('names the minor only for a guardian', () => {
    const a = { versionId: 'v1', typedName: 'Pat', signature: 'iVBORw0KGgo=' };
    expect(AgreementAcceptanceInputSchema.safeParse({ ...a, signerRole: 'self' }).success).toBe(
      true,
    );
    expect(AgreementAcceptanceInputSchema.safeParse({ ...a, signerRole: 'guardian' }).success).toBe(
      false,
    );
    expect(
      AgreementAcceptanceInputSchema.safeParse({ ...a, signerRole: 'guardian', minorName: 'Kit' })
        .success,
    ).toBe(true);
    expect(
      AgreementAcceptanceInputSchema.safeParse({ ...a, signerRole: 'self', minorName: 'Kit' })
        .success,
    ).toBe(false);
  });
});

describe('kiosk reader default', () => {
  it('is off until the admin turns it on', () => {
    const parsed = KioskDeviceSettingsSchema.parse({ ...settings });
    expect(parsed.nfcReader.use).toBe(false);
  });
});
