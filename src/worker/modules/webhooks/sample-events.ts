import type { Mode } from '../../../shared/contracts/common.ts';
import type { WebhookEventType } from '../../../shared/contracts/webhooks.ts';
import type { FeedRow } from './payload.ts';

/** The pass every sample event describes. It is not a real pass: nothing resolves it, and the event says `sample: true`. */
const SAMPLE_PASS = {
  passId: 'sample-pass',
  templateId: 'sample-template',
  externalId: 'sample_order_1042',
};

/** What the ledger would hold for each type: `buildEnvelope` then keeps only the allowlisted fields. */
const DATA: Record<WebhookEventType, Record<string, unknown>> = {
  'pass.issued': { version: 1, source: 'api' },
  'pass.updated': { version: 2, cause: 'fields', source: 'api', notified: true },
  'pass.voided': {},
  'pass.unvoided': {},
  'pass.removed': { version: 3, message: true },
  'pass.restored': { version: 4 },
  'pass.installed': {},
  'pass.uninstalled': { reason: 'wallet' },
  'pass.scanned': {
    scanId: 'sample-scan',
    actionKind: 'check_in',
    method: 'qr',
    scannerId: 'sample-scanner',
    direction: 'in',
    zoneId: 'sample-zone',
  },
  'pass.scan_refused': { scanId: 'sample-scan', reason: 'already_used', method: 'qr' },
  'pass.scan_undone': { scanId: 'sample-scan', scannerId: 'sample-scanner' },
  'pass.channels_changed': { channel: 'google', from: 'off', to: 'on', source: 'org' },
  'pass.printed': { printId: 'sample-print', generation: 1 },
  'pass.print_voided': { printId: 'sample-print', cause: 'reprint' },
  'push.failed': { version: 2, status: 410, reason: 'Unregistered', code: 'APNS_GONE' },
  'email.failed': { code: 'MAIL_BOUNCED' },
  'webhook.test': {},
};

const ROW: Partial<Record<WebhookEventType, Partial<FeedRow>>> = {
  'pass.voided': { actorType: 'user' },
  'pass.unvoided': { actorType: 'user' },
  'pass.installed': { device: 'a1b2c3d4e5f6', deviceCount: 1 },
  'pass.uninstalled': { device: 'a1b2c3d4e5f6', deviceCount: 0 },
  'pass.scan_refused': { kind: 'scan.refused' },
};

/** A journal row for a sample event of `type`. `webhook.test` is built by `testEnvelope`, not from a row. */
export function sampleRow(
  type: WebhookEventType,
  at: { eventId: string; orgId: string; mode: Mode; now: number },
): FeedRow {
  return {
    seq: 0,
    eventId: at.eventId,
    orgId: at.orgId,
    mode: at.mode,
    ...SAMPLE_PASS,
    type,
    kind: type,
    device: null,
    deviceCount: null,
    actorType: null,
    data: JSON.stringify(DATA[type]),
    at: at.now,
    ...ROW[type],
  };
}
