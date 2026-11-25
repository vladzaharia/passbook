import type { RetentionClass } from '../privacy/data-classes.ts';

/** Words on the Retention page, its settings and the platform policy summary. */
export const RETENTION_COPY = {
  title: 'Retention',
  windowsTitle: 'Retention windows',
  windowsNote: 'Empty uses the platform default. A shorter window starts after 7 days.',
  holdNote: 'A hold keeps the held records until it is released. Nothing under a hold is deleted.',
  heldBanner: 'A legal hold is active. Held records are kept until it is released.',
  holdsTitle: 'Legal holds',
  holdsLede:
    'A hold stops deletion, visitor clean-up and erasure for the whole organization or one pass.',
  platformHold: 'PassBook placed this hold. Ask PassBook to release it.',
  noHolds: 'No holds',
  place: 'Place hold',
  placeOrg: 'Hold the whole organization',
  placePass: 'Hold one pass',
  release: 'Release',
  receiptsTitle: 'Retention receipts',
  noReceipts: 'No receipts yet',
  download: 'Download',
  verified: 'Verified',
  unverified: 'Not verified',
  auditNote: (days: number) => `Kept ${days} days unless held.`,
  readOnlyWindows: 'Only an organization admin can change these.',
} as const;

/** What each window deletes, one plain sentence. */
export const RETENTION_LINES: Record<RetentionClass, string> = {
  scans: 'Deletes scan records (time, place, result, staff) after this many days.',
  events: 'Deletes pass activity (opens, adds, updates, syncs) after this many days.',
  visitors: 'Deletes a pass on a guest plan this many days after its visit ends.',
  delivery: 'Deletes emails sent to holders and push results after this many days.',
  photos: 'Deletes photos of voided passes after this many days.',
  imports: 'Clears imported rows and sync error detail after this many days. Counts stay.',
  webhooks: 'Deletes the event feed and webhook deliveries after this many days.',
};

/** The platform policy summary's lines under each retention row. */
export const PLATFORM_RETENTION_LINES = {
  audit: 'Deletes audit entries older than this. Never below 365 days.',
  events: 'Default for pass activity. An organization may choose its own.',
  scans: 'Default for scan records. An organization may choose its own.',
  sandbox: 'Deletes Test mode passes, scans and emails after this many days.',
  versions: 'Older signed pass files are deleted.',
} as const;

export const CLASS_RECEIPT_LABEL: Record<string, string> = {
  erasure: 'Data request erasure',
};
