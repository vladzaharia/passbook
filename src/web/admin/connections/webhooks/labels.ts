import type { WebhookEventType } from '@/shared/contracts/webhooks.ts';

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
