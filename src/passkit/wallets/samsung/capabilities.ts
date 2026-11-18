/**
 * What each Samsung type can carry (architecture 4.1): the best case per capability. A limit
 * (a value too long, a notice that is full) can only make an item worse than its declared level,
 * never better. Cells the design marks "verify" are `text` or `omitted` until a recorded fixture
 * pins the native attribute.
 */
import { CAPABILITY_IDS, type CapabilityId, type Support } from '../types.ts';
import type { SamsungType } from './context.ts';

type Table = Record<CapabilityId, Support>;

const ALL_TEXT = 'text' as const;
const base = (): Table =>
  Object.fromEntries(
    CAPABILITY_IDS.map((id): [CapabilityId, Support] => [
      id,
      id.startsWith('field.') || id.startsWith('role.') ? ALL_TEXT : 'native',
    ]),
  ) as Table;

function declare(overrides: Partial<Table>): Table {
  return { ...base(), ...overrides };
}

const SHARED: Partial<Table> = {
  'barcode.format': 'omitted',
  'colors.label': 'difference',
  'image.icon': 'unsupported',
  'image.thumbnail': 'omitted',
  'image.personal': 'omitted',
  'relevance.beacons': 'unsupported',
  'relevance.maxDistance': 'unsupported',
  'messaging.notify': 'difference',
  'localization.images': 'difference',
  'links.featured': 'text',
  sharing: 'omitted',
  nfc: 'unsupported',
  personalization: 'unsupported',
  'text.length': 'difference',
  'role.appLink': 'native',
  'role.support': 'native',
  'role.title': 'native',
  'role.eventId': 'unsupported',
  'role.redemptionChannel': 'unsupported',
};

const LOYALTY = declare({
  ...SHARED,
  type: 'omitted',
  'upcoming.multi': 'difference',
  'role.venueLocation': 'native',
  'role.points': 'native',
  'role.pointsLabel': 'native',
  'role.balance': 'native',
  'role.eventStart': 'native',
  'role.eventEnd': 'native',
  'role.validFrom': 'native',
  'role.validUntil': 'native',
});

const TICKET = declare({
  ...SHARED,
  'upcoming.multi': 'difference',
  'role.venueLocation': 'native',
  'role.eventName': 'native',
  'role.eventStart': 'native',
  'role.eventEnd': 'native',
  'role.eventId': 'native',
  'role.confirmationCode': 'native',
  'role.ticketNumber': 'native',
  'role.validFrom': 'native',
  'role.validUntil': 'native',
});

const COUPON = declare({
  ...SHARED,
  'image.logo': 'omitted',
  'relevance.locations': 'omitted',
  'upcoming.multi': 'omitted',
  'role.venueLocation': 'omitted',
  'role.offerTitle': 'native',
  'role.eventStart': 'native',
  'role.validFrom': 'native',
  'role.validUntil': 'native',
});

export const SAMSUNG_CAPABILITIES: Record<SamsungType, Table> = {
  loyalty: LOYALTY,
  ticket: TICKET,
  coupon: COUPON,
};
