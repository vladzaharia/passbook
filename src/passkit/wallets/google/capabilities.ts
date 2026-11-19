/**
 * What each Google type carries, per capability id (architecture 4.1). This is the best case for a
 * pass that uses the capability: a missing image or an over-long list is reported as a worse
 * level in the fidelity items. `capabilities.test.ts` holds the compilers to it.
 */
import {
  CAPABILITY_IDS,
  type CapabilityId,
  type Support,
  VIEW_GROUPS,
  type WalletRole,
} from '../types.ts';
import type { GoogleType } from './types.ts';

/** Roles with a native slot on each type; every other role is carried as a text module. */
export const NATIVE_ROLES: Record<GoogleType, readonly WalletRole[]> = {
  generic: ['title', 'subtitle', 'venueLocation', 'validFrom', 'validUntil', 'support'],
  event: [
    'eventName',
    'eventStart',
    'eventEnd',
    'doorsOpen',
    'venueName',
    'venueAddress',
    'venueLocation',
    'seat',
    'row',
    'section',
    'gate',
    'ticketHolder',
    'ticketNumber',
    'confirmationCode',
    'eventId',
    'validFrom',
    'validUntil',
    'support',
  ],
  loyalty: [
    'memberId',
    'memberName',
    'points',
    'pointsLabel',
    'balance',
    'venueLocation',
    'validUntil',
    'support',
  ],
  gift: ['giftCardNumber', 'giftCardPin', 'balance', 'venueLocation', 'validUntil', 'support'],
  offer: [
    'offerTitle',
    'offerDetails',
    'finePrint',
    'redemptionChannel',
    'venueLocation',
    'validFrom',
    'validUntil',
    'support',
  ],
};

const FORMATS = new Set(['qr', 'pdf417', 'aztec', 'code128', 'code39', 'codabar', 'ean13']);
const BEST: Partial<Record<CapabilityId, Support>> = {
  'image.personal': 'omitted',
  'colors.foreground': 'difference',
  'colors.label': 'difference',
  'relevance.beacons': 'unsupported',
  'relevance.maxDistance': 'difference',
  'localization.images': 'difference',
  'text.length': 'difference',
  nfc: 'unsupported',
  personalization: 'unsupported',
  'role.appLink': 'unsupported',
};

function supportOf(type: GoogleType, id: CapabilityId): Support {
  const best = BEST[id];
  if (best) return best;
  if (id.startsWith('role.'))
    return NATIVE_ROLES[type].includes(id.slice(5) as WalletRole) ? 'native' : 'text';
  if (id === 'barcode.format.i2of5') return 'difference';
  if (id.startsWith('barcode.format.'))
    return FORMATS.has(id.slice('barcode.format.'.length)) ? 'native' : 'omitted';
  if (VIEW_GROUPS.some((g) => id === `field.${g}`)) return 'text';
  if (id === 'relevance.dates') return type === 'loyalty' || type === 'gift' ? 'omitted' : 'native';
  if (id === 'upcoming.multi') return type === 'generic' || type === 'event' ? 'text' : 'omitted';
  return 'native';
}

export function googleCapabilities(type: GoogleType): Record<CapabilityId, Support> {
  return Object.fromEntries(CAPABILITY_IDS.map((id) => [id, supportOf(type, id)])) as Record<
    CapabilityId,
    Support
  >;
}
