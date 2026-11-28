import { describe, expect, it } from 'vitest';
import { CUSTOMER_REASON_SUB } from '../copy/scan-customer.ts';
import { KIOSK_SUB_LINES } from '../copy/scan-kiosk.ts';
import { GuestCodeInputSchema, normalizeGuestCode } from './guest-codes.ts';
import {
  KIOSK_ALLOWED_ENDPOINTS,
  KioskConfigSchema,
  KioskHeartbeatSchema,
  KioskViewSchema,
} from './scan-kiosk.ts';

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
        card: { label: 'Checked in', band: 'in' },
      }).success,
    ).toBe(true);
    for (const extra of [{ reason: 'expired' }, { passId: 'p' }, { count: 4 }, { staff: 'Sam' }]) {
      expect(KioskViewSchema.safeParse({ screen: 'see_desk', ...extra }).success).toBe(false);
    }
  });
  it('shows at most 4 rows and only the four subs', () => {
    const row = { handle: 'h', firstName: 'Dana', hint: 'Pass ••42' };
    expect(KioskViewSchema.safeParse({ screen: 'choose', rows: Array(5).fill(row) }).success).toBe(
      false,
    );
    expect(KioskViewSchema.safeParse({ screen: 'see_desk', sub: 'suspended' }).success).toBe(false);
    expect(KioskViewSchema.safeParse({ screen: 'see_desk', sub: 'capacity_full' }).success).toBe(
      true,
    );
  });
  it('keeps the sub lines the shipped ones', () => {
    for (const [key, line] of Object.entries(KIOSK_SUB_LINES)) {
      expect(CUSTOMER_REASON_SUB[key as keyof typeof CUSTOMER_REASON_SUB]).toBe(line);
    }
  });
});

describe('KioskHeartbeatSchema', () => {
  it('takes battery and the reader without reportedAt', () => {
    const reader = {
      state: 'ready',
      model: 'acr1555u',
      transport: 'bluetooth',
      pinned: true,
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
    const paths = KIOSK_ALLOWED_ENDPOINTS.map(([, p]) => p);
    expect(paths.some((p) => p.startsWith('/scan/devices'))).toBe(false);
    expect(
      KIOSK_ALLOWED_ENDPOINTS.find(([m, p]) => m === 'GET' && p === '/scan/help'),
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
