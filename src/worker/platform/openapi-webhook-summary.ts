import type { WebhookEventType } from '../../shared/contracts/webhooks.ts';

export const SUMMARY: Record<WebhookEventType, string> = {
  'pass.issued': 'A pass was created.',
  'pass.updated': 'A pass changed and a new version was published.',
  'pass.voided': 'A pass was voided.',
  'pass.unvoided': 'A void was undone.',
  'pass.removed': 'A pass was removed from Wallet.',
  'pass.restored': 'A removed pass was restored.',
  'pass.installed': "A pass was added to a device's Wallet.",
  'pass.uninstalled': "A pass left a device's Wallet.",
  'pass.scanned': 'A scan of the pass succeeded.',
  'pass.scan_refused': 'A scan of the pass was refused.',
  'pass.scan_undone': 'A scan was undone.',
  'pass.channels_changed': 'A delivery channel of the pass turned on or off.',
  'pass.printed': 'A printed ticket was issued.',
  'pass.print_voided': 'A printed ticket was voided.',
  'pass.replaced': 'The pass was replaced by another pass, which now carries its state.',
  'push.failed': 'A Wallet push for the pass failed.',
  'email.failed': 'An email for the pass failed.',
  'webhook.test': 'Sent on request to test an endpoint.',
};
