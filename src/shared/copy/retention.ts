/** Words on the Retention page, its settings and the platform policy summary. */
export const RETENTION_COPY = {
  title: 'Retention',
  windowsTitle: 'Retention windows',
  heldBanner: 'A legal hold is active. Held records are kept until it is released.',
  holdsTitle: 'Legal holds',
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
  readOnlyWindows: 'Only an organization admin can change these.',
} as const;

export const CLASS_RECEIPT_LABEL: Record<string, string> = {
  erasure: 'Data request erasure',
};
