import type { WebhookEventType } from '@/shared/contracts/webhooks.ts';
import { entityLabel } from '../../../lib/entity-label.ts';

export const EVENT_LABEL: Record<WebhookEventType, string> = {
  'pass.issued': 'Issued',
  'pass.updated': 'Updated',
  'pass.voided': 'Voided',
  'pass.unvoided': 'Unvoided',
  'pass.removed': 'Removed',
  'pass.restored': 'Restored',
  'pass.installed': 'Installed',
  'pass.uninstalled': 'Uninstalled',
  'pass.scanned': 'Scanned',
  'pass.scan_refused': 'Refused',
  'pass.scan_undone': 'Undone',
  'pass.channels_changed': 'Channels changed',
  'pass.printed': 'Printed',
  'pass.print_voided': 'Print voided',
  'push.failed': 'Push failed',
  'email.failed': 'Email failed',
  'webhook.test': 'Test event',
};

export const EVENT_GROUP: Record<WebhookEventType, string> = {
  'pass.issued': 'Passes',
  'pass.updated': 'Passes',
  'pass.voided': 'Passes',
  'pass.unvoided': 'Passes',
  'pass.removed': 'Passes',
  'pass.restored': 'Passes',
  'pass.installed': 'Wallet',
  'pass.uninstalled': 'Wallet',
  'pass.scanned': 'Scans',
  'pass.scan_refused': 'Scans',
  'pass.scan_undone': 'Scans',
  'pass.channels_changed': 'Passes',
  'pass.printed': 'Passes',
  'pass.print_voided': 'Passes',
  'push.failed': 'Delivery',
  'email.failed': 'Delivery',
  'webhook.test': 'Test',
};

/** The groups the endpoint form shows, in order. The test event is sent on request, never subscribed. */
export const EVENT_GROUPS = ['Passes', 'Wallet', 'Scans', 'Delivery'] as const;

const ERROR_LABEL: Record<string, string> = {
  TIMEOUT: 'No answer in 10 s',
  REDIRECT_BLOCKED: 'Redirected (not followed)',
  UNSAFE_URL: 'Host not allowed',
  DNS_FAILED: 'Host not found',
  UPSTREAM: 'Connection failed',
  ENDPOINT_DISABLED: 'Endpoint disabled',
  UNSUBSCRIBED: 'No longer subscribed',
};

/** A delivery's last result: an HTTP status, or a stable error code. */
export function responseLabel(status: number | null, code: string | null): string {
  if (status !== null) return `HTTP ${status}`;
  if (!code) return '';
  return ERROR_LABEL[code] ?? 'Failed';
}

export const DELIVERY_STATE_LABEL = {
  pending: 'Pending',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

/** The kit status each delivery state wears. */
export const DELIVERY_STATUS = {
  pending: 'pending',
  delivered: 'verified',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

export const TRIGGER_LABEL = {
  event: 'First send',
  retry: 'Retry',
  replay: 'Replay',
  test: 'Test',
} as const;

export const OVERLAP_OPTIONS = [
  { value: '0', label: 'Now' },
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
] as const;

/** A failed delivery always reads as something: an unknown code is a plain "Failed". */
export function failureLabel(status: number | null, code: string | null): string {
  return responseLabel(status, code) || 'Failed';
}

/** The pass a delivery is about: its own id from the issuer, else the tail of the PassBook id. */
export function passLabel(d: { externalId: string | null; passId: string }): string {
  return entityLabel(d.externalId, `Pass ${d.passId.slice(-6)}`);
}
