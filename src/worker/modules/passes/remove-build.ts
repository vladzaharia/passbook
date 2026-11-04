import { PASS_STYLES, type PassJson } from '../../../passkit/types.ts';

export interface Removal {
  /** Shown once on the lock screen through a changeMessage; null for a silent removal. */
  message: string | null;
  at: number;
}

/** Keys that would keep the pass useful (scannable, nearby, surfaced) after it is removed. */
const STRIPPED = [
  'barcode',
  'barcodes',
  'locations',
  'beacons',
  'relevantDate',
  'relevantDates',
  'featuredActions',
  'nfc',
  'upcomingPassInformation',
] as const;

export const REMOVAL_FIELD_KEY = 'passbook_removed';

/**
 * The last version of a pass: voided, expired now and stripped of everything a reader or Wallet
 * would act on. Apple has no call that deletes a pass from a device; this is what the issuer can do.
 */
export function applyRemoval(pass: PassJson, removal: Removal): void {
  const json = pass as Record<string, unknown>;
  for (const key of STRIPPED) delete json[key];
  json.voided = true;
  json.expirationDate = new Date(removal.at).toISOString();
  if (!removal.message) return;
  const style = PASS_STYLES.find((s) => json[s] && typeof json[s] === 'object');
  if (!style) return;
  const dict = json[style] as Record<string, unknown>;
  const back = (Array.isArray(dict.backFields) ? dict.backFields : []) as { key?: unknown }[];
  dict.backFields = [
    ...back.filter((f) => f.key !== REMOVAL_FIELD_KEY),
    { key: REMOVAL_FIELD_KEY, label: 'Removed', value: removal.message, changeMessage: '%@' },
  ];
}
