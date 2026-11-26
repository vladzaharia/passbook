import { describe, expect, it } from 'vitest';
import {
  EVENT_GROUP,
  EVENT_GROUPS,
  EVENT_LABEL,
  responseLabel,
} from '../../web/admin/connections/webhooks/labels.ts';
import { ApiScopeSchema } from './common.ts';
import {
  CreateWebhookEndpointSchema,
  EventFeedQuerySchema,
  SUBSCRIBABLE_EVENT_TYPES,
  UpdateWebhookEndpointSchema,
  WEBHOOK_DATA_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  WebhookEventSchema,
  WebhookReplaySchema,
} from './webhooks.ts';

const base = {
  id: '0193a1b2-0000-7000-8000-000000000001',
  apiVersion: '2026-11-20',
  createdAt: 1764000000000,
  orgId: 'org1',
  mode: 'live',
  pass: { id: 'p1', externalId: 'booking_8841', templateId: 't1' },
};
const DATA: Record<string, object> = {
  'pass.issued': { version: 1, source: null },
  'pass.updated': { version: 2, cause: 'publish', source: 'broadcast', notified: true },
  'pass.voided': { actorType: 'user' },
  'pass.unvoided': { actorType: 'user' },
  'pass.removed': { version: 3, message: false },
  'pass.restored': { version: 4 },
  'pass.installed': { wallet: 'apple', device: 'abcdef012345', deviceCount: 1, firstDevice: true },
  'pass.uninstalled': {
    wallet: 'apple',
    device: 'abcdef012345',
    deviceCount: 0,
    lastDevice: true,
    cause: 'wallet',
  },
  'pass.scanned': { scanId: 's1', action: 'check_in', outcome: 'ok', direction: 'in', amount: 2 },
  'pass.scan_refused': { scanId: 's1', reason: 'USED', method: 'qr' },
  'pass.scan_undone': { scanId: 's1', scannerId: 'sc1', staffId: null },
  'pass.channels_changed': { channel: 'apple', from: 'on', to: 'off', source: 'template' },
  'pass.printed': { printId: 'pr1', generation: 2, voided: 1 },
  'pass.print_voided': { printId: 'pr1', cause: 'holder_change' },
  'push.failed': { version: 2, status: 410, reason: 'Unregistered', code: 'X' },
  'email.failed': { code: 'EMAIL_OUTCOME_UNKNOWN' },
  'webhook.test': {},
};

describe('webhook catalog', () => {
  it('every type has a data schema, a label, a group and a fixture', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(WEBHOOK_DATA_SCHEMAS[type], type).toBeDefined();
      expect(EVENT_LABEL[type], type).toBeTruthy();
      expect(EVENT_GROUP[type], type).toBeTruthy();
      expect(DATA[type], type).toBeDefined();
    }
  });

  it('every subscribable type sits in a group the form shows', () => {
    for (const type of SUBSCRIBABLE_EVENT_TYPES)
      expect(EVENT_GROUPS as readonly string[]).toContain(EVENT_GROUP[type]);
  });

  it('envelope fixtures parse for every type', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      const pass = type === 'webhook.test' ? null : base.pass;
      const r = WebhookEventSchema.safeParse({ ...base, type, pass, data: DATA[type] });
      expect(r.success, type).toBe(true);
    }
  });

  it('only webhook.test allows pass: null', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      const nullPass = WebhookEventSchema.safeParse({
        ...base,
        type,
        pass: null,
        data: DATA[type],
      });
      expect(nullPass.success, type).toBe(type === 'webhook.test');
    }
    const withPass = WebhookEventSchema.safeParse({ ...base, type: 'webhook.test', data: {} });
    expect(withPass.success).toBe(false);
  });

  it('refuses unknown types', () => {
    expect(WebhookEventSchema.safeParse({ ...base, type: 'pass.exploded', data: {} }).success).toBe(
      false,
    );
    expect(
      CreateWebhookEndpointSchema.safeParse({
        url: 'https://example.com/h',
        eventTypes: ['pass.exploded'],
      }).success,
    ).toBe(false);
    expect(
      CreateWebhookEndpointSchema.safeParse({
        url: 'https://example.com/h',
        eventTypes: ['webhook.test'],
      }).success,
    ).toBe(false);
    expect(EventFeedQuerySchema.safeParse({ types: 'pass.issued,nope' }).success).toBe(false);
  });

  it('feed cursors are ev2.<opaque>, the older ev1.<seq>, or now', () => {
    for (const after of ['now', 'ev1.42', 'ev1.0', `ev2.${'A'.repeat(22)}`])
      expect(EventFeedQuerySchema.safeParse({ after }).success).toBe(true);
    for (const after of ['42', 'ev1.-1', 'ev1.01', 'ev2.1', `ev2.${'A'.repeat(23)}`])
      expect(EventFeedQuerySchema.safeParse({ after }).success).toBe(false);
  });

  it('keeps the update description to one plain line, and lets an empty one clear it', () => {
    const ok = (description: string) =>
      UpdateWebhookEndpointSchema.safeParse({ description }).success;
    expect(ok('Door')).toBe(true);
    expect(ok('')).toBe(true);
    expect(ok('two\nlines')).toBe(false);
    expect(ok('x'.repeat(121))).toBe(false);
  });

  it('bounds the cursor to a safe integer and requires a replay range in order', () => {
    expect(EventFeedQuerySchema.safeParse({ after: `ev1.${'9'.repeat(15)}` }).success).toBe(true);
    expect(EventFeedQuerySchema.safeParse({ after: `ev1.${'9'.repeat(16)}` }).success).toBe(false);
    expect(WebhookReplaySchema.safeParse({ from: 1, to: 2 }).success).toBe(true);
    expect(WebhookReplaySchema.safeParse({ from: 3, to: 2 }).success).toBe(false);
  });

  it('labels responses', () => {
    expect(responseLabel(503, null)).toBe('HTTP 503');
    expect(responseLabel(null, 'TIMEOUT')).toBe('No answer in 10 s');
    expect(responseLabel(null, 'ENDPOINT_DISABLED')).toBe('Endpoint disabled');
  });
});

describe('API key scopes', () => {
  it('lists every scope, including webhooks:manage', () => {
    expect(ApiScopeSchema.options).toEqual([
      'passes:read',
      'passes:write',
      'holders:write',
      'templates:read',
      'messages:write',
      'scans:read',
      'scans:write',
      'connections:read',
      'connections:write',
      'webhooks:manage',
      'templates:write',
      'templates:review',
      'templates:publish',
      'messages:read',
      'scanning:write',
      'scan-setup:read',
      'scan-setup:write',
      'scanning:admin',
      'nfc:keys',
      'nfc:read',
      'nfc:write',
      'wallet:read',
      'wallet:write',
      'api-keys:write',
      'org:read',
      'org:write',
      'members:read',
      'members:write',
      'audit:read',
      'logs:read',
      'platform:orgs',
      'platform:users',
      'platform:identities',
      'platform:wallet',
      'platform:settings',
      'platform:status',
      'platform:templates',
      'platform:audit',
      'platform:claims',
      'brand:manage',
    ]);
  });
});
