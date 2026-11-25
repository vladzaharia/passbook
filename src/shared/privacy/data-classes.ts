/** The seven retention classes an org may set. One table read by contracts, jobs, the about page and the summary. */
export const RETENTION_CLASSES = [
  'scans',
  'events',
  'visitors',
  'delivery',
  'photos',
  'imports',
  'webhooks',
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export type OnExpiry = 'deleted' | 'pass_deleted' | 'photo_deleted' | 'anonymised';

export interface DataClass {
  cls: RetentionClass;
  /** Org and platform setting key. The platform key holds the default. */
  key: `retention.${RetentionClass}Days`;
  /** Platform setting key of the maximum an org may choose. */
  maxKey: `retention.${RetentionClass}MaxDays`;
  label: string;
  /** What is kept, for the summary. */
  holds: string;
  floor: number;
  platformDefault: number;
  /** Default of the platform maximum. */
  platformMax: number;
  ceiling: number;
  onExpiry: OnExpiry;
}

export const DATA_CLASSES: Readonly<Record<RetentionClass, DataClass>> = {
  scans: {
    cls: 'scans',
    key: 'retention.scansDays',
    maxKey: 'retention.scansMaxDays',
    label: 'Scans',
    holds: 'Time, place, result and staff of each scan, and staff notes on a pass',
    floor: 30,
    platformDefault: 396,
    platformMax: 1095,
    ceiling: 3650,
    onExpiry: 'deleted',
  },
  events: {
    cls: 'events',
    key: 'retention.eventsDays',
    maxKey: 'retention.eventsMaxDays',
    label: 'Pass activity',
    holds: 'When a pass was opened, added, updated or synced',
    floor: 7,
    platformDefault: 90,
    platformMax: 730,
    ceiling: 3650,
    onExpiry: 'deleted',
  },
  visitors: {
    cls: 'visitors',
    key: 'retention.visitorsDays',
    maxKey: 'retention.visitorsMaxDays',
    label: 'Visitor passes',
    holds: 'Passes on a guest plan, after the visit ends',
    floor: 1,
    platformDefault: 90,
    platformMax: 400,
    ceiling: 400,
    onExpiry: 'pass_deleted',
  },
  delivery: {
    cls: 'delivery',
    key: 'retention.deliveryDays',
    maxKey: 'retention.deliveryMaxDays',
    label: 'Emails and pushes',
    holds: 'Emails sent to holders and push results',
    floor: 7,
    platformDefault: 30,
    platformMax: 90,
    ceiling: 90,
    onExpiry: 'deleted',
  },
  photos: {
    cls: 'photos',
    key: 'retention.photosDays',
    maxKey: 'retention.photosMaxDays',
    label: 'Photos',
    holds: 'Photos of voided passes',
    floor: 1,
    platformDefault: 30,
    platformMax: 400,
    ceiling: 400,
    onExpiry: 'photo_deleted',
  },
  imports: {
    cls: 'imports',
    key: 'retention.importsDays',
    maxKey: 'retention.importsMaxDays',
    label: 'Imports',
    holds: 'Imported rows and sync error detail',
    floor: 1,
    platformDefault: 30,
    platformMax: 90,
    ceiling: 90,
    onExpiry: 'anonymised',
  },
  webhooks: {
    cls: 'webhooks',
    key: 'retention.webhooksDays',
    maxKey: 'retention.webhooksMaxDays',
    label: 'Webhooks',
    holds: 'Event feed and webhook deliveries',
    floor: 1,
    platformDefault: 30,
    platformMax: 30,
    ceiling: 30,
    onExpiry: 'deleted',
  },
};

export const ON_EXPIRY_TEXT: Record<OnExpiry, string> = {
  deleted: 'Deleted',
  pass_deleted: 'Pass deleted',
  photo_deleted: 'Photo deleted',
  anonymised: 'Anonymised',
};

/** Platform-only retention, listed in the summary and not settable by an org. */
export const PLATFORM_ONLY_RETENTION: readonly { label: string; text: string }[] = [
  { label: 'Audit log', text: '365 days or more' },
  { label: 'Apple device logs', text: '7 days' },
  { label: 'Sign-in links and sessions', text: 'Until they expire' },
  { label: 'Deleted passes', text: 'Purged after 7 days' },
  { label: 'Backups', text: '30 days' },
];

/** Days in an org's chosen value are valid when whole and inside [floor, ceiling]. */
export function isValidDays(cls: RetentionClass, value: unknown): value is number {
  const c = DATA_CLASSES[cls];
  return Number.isInteger(value) && (value as number) >= c.floor && (value as number) <= c.ceiling;
}

export const isRetentionClass = (value: string): value is RetentionClass =>
  (RETENTION_CLASSES as readonly string[]).includes(value);
