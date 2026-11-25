import { describe, expect, it } from 'vitest';
import { WebhookEventSchema } from '../../../shared/contracts/webhooks.ts';
import { bodyOf, buildEnvelope, type FeedRow, testEnvelope } from './payload.ts';

const row = (over: Partial<FeedRow> & { kind: string; type: string }): FeedRow => ({
  seq: 7,
  eventId: '0193a1b2-0000-7000-8000-000000000001',
  orgId: 'org1',
  mode: 'live',
  passId: 'pass1',
  templateId: 'tpl1',
  externalId: 'booking_8841',
  device: null,
  deviceCount: null,
  actorType: null,
  data: '{}',
  at: 1764000000000,
  ...over,
});

const PII = 'SENTINEL-PII';
/** Keys a ledger row could carry that must never leave. */
const LEAKY = {
  memberName: PII,
  holderEmail: PII,
  holder_name: PII,
  personalization: { name: PII },
  before: PII,
  after: PII,
  pushToken: PII,
  deviceId: PII,
  approvedBy: PII,
  apiKeyId: PII,
  outboxId: PII,
  bundleId: PII,
  undoes: PII,
  appleGeneration: 3,
  url: `https://wallet.test/${PII}`,
};

const CASES: [string, Partial<FeedRow>, Record<string, unknown>][] = [
  ['pass.issued', {}, { version: 1, cause: 'create', source: null }],
  ['pass.updated', {}, { version: 2, cause: 'publish', source: 'broadcast', notified: true }],
  ['pass.voided', { actorType: 'user' }, {}],
  ['pass.unvoided', { actorType: 'api_key' }, {}],
  ['pass.removed', {}, { version: 3, message: true }],
  ['pass.restored', {}, { version: 4 }],
  ['pass.installed', { device: 'abcdef012345', deviceCount: 1 }, {}],
  ['pass.uninstalled', { device: 'abcdef012345', deviceCount: 0 }, { reason: 'device' }],
  [
    'pass.scanned',
    {},
    {
      scanId: 's1',
      actionKind: 'check_in',
      outcome: 'ok',
      method: 'camera',
      eventId: 'e1',
      scannerId: 'sc1',
      staffId: null,
      override: false,
      offline: true,
      amount: 2,
      direction: 'in',
    },
  ],
  ['pass.scan_refused', {}, { scanId: 's1', reason: 'USED', method: 'qr', outcome: 'refused' }],
  ['pass.scan_undone', {}, { scanId: 's2', scannerId: 'sc1', staffId: 'st1' }],
  [
    'push.failed',
    {},
    { version: 2, status: 410, reason: 'Unregistered', code: 'X', outcome: 'gone' },
  ],
  ['email.failed', {}, { code: 'EMAIL_OUTCOME_UNKNOWN' }],
];

const KIND: Record<string, string> = {
  'pass.installed': 'device.registered',
  'pass.uninstalled': 'device.unregistered',
  'pass.scanned': 'scan.checked_in',
  'pass.scan_refused': 'scan.rejected',
  'pass.scan_undone': 'scan.undone',
};

describe('payload allowlist', () => {
  it.each(CASES)('%s: parses and drops everything not listed', (type, over, data) => {
    const r = row({
      type,
      kind: KIND[type] ?? type,
      ...over,
      data: JSON.stringify({ ...data, ...LEAKY }),
    });
    const event = buildEnvelope(r);
    expect(WebhookEventSchema.safeParse(event).success, type).toBe(true);
    const json = JSON.stringify(event);
    expect(json).not.toContain(PII);
    for (const key of [
      'approvedBy',
      'apiKeyId',
      'outboxId',
      'bundleId',
      'undoes',
      'appleGeneration',
    ])
      expect(json).not.toContain(key);
    expect(event).toMatchObject({
      id: r.eventId,
      type,
      apiVersion: '2026-11-20',
      createdAt: r.at,
      orgId: 'org1',
      mode: 'live',
      pass: { id: 'pass1', externalId: 'booking_8841', templateId: 'tpl1' },
    });
  });

  it('emits exactly the listed fields for a scan', () => {
    const [, , data] = CASES.find(([t]) => t === 'pass.scanned') ?? [];
    const event = buildEnvelope(
      row({ type: 'pass.scanned', kind: 'scan.checked_in', data: JSON.stringify(data) }),
    );
    expect(event.data).toEqual({
      scanId: 's1',
      action: 'check_in',
      method: 'camera',
      eventId: 'e1',
      scannerId: 'sc1',
      staffId: null,
      override: false,
      offline: true,
      amount: 2,
      outcome: 'ok',
      direction: 'in',
    });
  });

  it('derives outcome and direction from the kind', () => {
    const at = (kind: string, data = '{}') =>
      buildEnvelope(row({ type: 'pass.scanned', kind, data })).data;
    expect(at('scan.heads_up')).toMatchObject({ outcome: 'heads_up' });
    expect(at('scan.checked_out')).toMatchObject({ outcome: 'ok', direction: 'out' });
    expect(at('scan.checked_in')).not.toHaveProperty('direction');
  });

  it('carries zoneId and exit on an out scan, and drops an unknown exit', () => {
    const at = (kind: string, data: object) =>
      buildEnvelope(row({ type: 'pass.scanned', kind, data: JSON.stringify(data) })).data;
    expect(at('scan.checked_out', { direction: 'out', zoneId: 'z1', exit: 'stay' })).toMatchObject({
      direction: 'out',
      zoneId: 'z1',
      exit: 'stay',
    });
    expect(at('scan.checked_out', { direction: 'out', exit: 'bogus' })).not.toHaveProperty('exit');
    expect(at('scan.checked_in', { direction: 'in', exit: 'scan' })).not.toHaveProperty('exit');
  });

  it('drops a field of the wrong type instead of coercing it', () => {
    const event = buildEnvelope(
      row({ type: 'pass.updated', kind: 'pass.updated', data: '{"version":"2","notified":"yes"}' }),
    );
    expect(event.data).toEqual({});
  });

  it('survives data that is not an object', () => {
    for (const data of ['not json', '[]', 'null', '"x"'])
      expect(buildEnvelope(row({ type: 'pass.issued', kind: 'pass.issued', data })).data).toEqual(
        {},
      );
  });

  it('derives lastDevice from the journal count and the cause from the ledger', () => {
    const r = (reason: string, deviceCount: number) =>
      buildEnvelope(
        row({
          type: 'pass.uninstalled',
          kind: 'device.unregistered',
          device: 'abcdef012345',
          deviceCount,
          data: JSON.stringify({ reason }),
        }),
      ).data;
    expect(r('push_gone', 0)).toMatchObject({
      cause: 'push_gone',
      deviceCount: 0,
      lastDevice: true,
    });
    expect(r('device', 2)).toMatchObject({ cause: 'wallet', deviceCount: 2, lastDevice: false });
  });

  it('drops a string longer than the contract bound, so the event still parses', () => {
    const event = buildEnvelope(
      row({
        type: 'push.failed',
        kind: 'push.failed',
        data: JSON.stringify({ status: 400, reason: 'x'.repeat(301), code: 'OK' }),
      }),
    );
    expect(event.data).toEqual({ status: 400, code: 'OK' });
    expect(WebhookEventSchema.safeParse(event).success).toBe(true);
  });

  it('is pure: a replay builds the identical event', () => {
    const r = row({ type: 'pass.updated', kind: 'pass.updated', data: '{"version":2}' });
    expect(bodyOf(buildEnvelope(r))).toBe(bodyOf(buildEnvelope(r)));
  });

  it('keeps the body within 8 KB and refuses to exceed it', () => {
    for (const [type, over, data] of CASES) {
      const r = row({ type, kind: KIND[type] ?? type, ...over, data: JSON.stringify(data) });
      expect(new TextEncoder().encode(bodyOf(buildEnvelope(r))).length).toBeLessThanOrEqual(8192);
    }
    const huge = row({ type: 'pass.issued', kind: 'pass.issued', externalId: 'x'.repeat(9000) });
    expect(() => bodyOf(buildEnvelope(huge))).toThrow('WEBHOOK_PAYLOAD_TOO_LARGE');
  });

  it('refuses a type outside the catalog', () => {
    expect(() => buildEnvelope(row({ type: 'pass.exploded', kind: 'x' }))).toThrow();
  });

  it('the test event has no pass', () => {
    const event = testEnvelope({ id: 'e', orgId: 'o', mode: 'test', now: 5 });
    expect(WebhookEventSchema.safeParse(event).success).toBe(true);
    expect(event.pass).toBeNull();
  });
});
