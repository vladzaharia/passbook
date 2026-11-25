import {
  BedDouble,
  CalendarClock,
  Dumbbell,
  Gift,
  IdCard,
  type LucideIcon,
  Plane,
  Ship,
  Ticket,
  Users,
} from 'lucide-react';
import { formatCalendarDate, formatWallTime } from '../../../lib/format.ts';

export interface DemoKeyField {
  pointer: string;
  label: string;
}

export interface DemoDataset {
  id: string;
  label: string;
  /** The count field's label. */
  noun: string;
  icon: LucideIcon;
  /** One line under the tile name. */
  blurb: string;
  /** A pointer only this dataset's records carry: how the aside knows which one a sample is. */
  fingerprint: string | null;
  /** Pointers joined into the record's name. */
  name: readonly string[];
  /** Six fields the record card shows. */
  keys: readonly DemoKeyField[];
  /** Blueprint names the dataset's fields are keyed to. */
  blueprints: readonly string[];
}

const k = (pointer: string, label: string): DemoKeyField => ({ pointer, label });

export const DEMO_DATASETS: readonly DemoDataset[] = [
  {
    id: 'gym-members',
    label: 'Gym members',
    noun: 'Members',
    icon: Dumbbell,
    blurb: 'Plans, visits, club.',
    fingerprint: '/homeClub',
    name: ['/memberName'],
    keys: [
      k('/memberId', 'Member ID'),
      k('/status', 'Status'),
      k('/plan', 'Plan'),
      k('/homeClub', 'Home club'),
      k('/visits', 'Visits'),
      k('/validUntil', 'Valid until'),
    ],
    blueprints: ['Monthly pass', 'Access card', 'Guest pass'],
  },
  {
    id: 'event-tickets',
    label: 'Event tickets',
    noun: 'Tickets',
    icon: Ticket,
    blurb: 'Seats, gates, doors.',
    fingerprint: '/eventName',
    name: ['/attendee'],
    keys: [
      k('/eventName', 'Event'),
      k('/venueName', 'Venue'),
      k('/seat', 'Seat'),
      k('/ticketType', 'Ticket'),
      k('/startsAt', 'Starts'),
      k('/status', 'Status'),
    ],
    blueprints: ['Event ticket', 'Timed ticket', 'Multi-day pass'],
  },
  {
    id: 'hotel-stays',
    label: 'Hotel stays',
    noun: 'Stays',
    icon: BedDouble,
    blurb: 'Rooms, nights, Wi-Fi.',
    fingerprint: '/reservation',
    name: ['/guest'],
    keys: [
      k('/reservation', 'Reservation'),
      k('/room', 'Room'),
      k('/checkIn', 'Check in'),
      k('/checkOut', 'Check out'),
      k('/loyaltyTier', 'Tier'),
      k('/status', 'Status'),
    ],
    blueprints: ['Hotel stay'],
  },
  {
    id: 'bookings',
    label: 'Bookings',
    noun: 'Bookings',
    icon: CalendarClock,
    blurb: 'Services, staff, slots.',
    fingerprint: '/bookingRef',
    name: ['/name'],
    keys: [
      k('/bookingRef', 'Booking'),
      k('/what', 'Service'),
      k('/where', 'Where'),
      k('/with', 'With'),
      k('/startsAt', 'Starts'),
      k('/status', 'Status'),
    ],
    blueprints: ['Booking'],
  },
  {
    id: 'boarding-passes',
    label: 'Boarding passes',
    noun: 'Passengers',
    icon: Plane,
    blurb: 'Flights, gates, seats.',
    fingerprint: '/flightNumber',
    name: ['/passengerGiven', '/passengerFamily'],
    keys: [
      k('/origin', 'From'),
      k('/destination', 'To'),
      k('/departsAt', 'Departs'),
      k('/gate', 'Gate'),
      k('/seat', 'Seat'),
      k('/boardingGroup', 'Group'),
    ],
    blueprints: ['Boarding pass'],
  },
  {
    id: 'loyalty-cards',
    label: 'Loyalty cards',
    noun: 'Cards',
    icon: Gift,
    blurb: 'Balance, points, stamps.',
    fingerprint: '/cardNumber',
    name: ['/holder'],
    keys: [
      k('/cardNumber', 'Card'),
      k('/tier', 'Tier'),
      k('/balance', 'Balance'),
      k('/points', 'Points'),
      k('/stamps', 'Stamps'),
      k('/memberSince', 'Member since'),
    ],
    blueprints: ['Balance card', 'Stamp card', 'Coupon'],
  },
  {
    id: 'staff-badges',
    label: 'Staff badges',
    noun: 'Badges',
    icon: IdCard,
    blurb: 'Teams, zones, validity.',
    fingerprint: '/company',
    name: ['/memberName'],
    keys: [
      k('/memberId', 'Badge ID'),
      k('/company', 'Company'),
      k('/team', 'Team'),
      k('/plan', 'Plan'),
      k('/validUntil', 'Valid until'),
      k('/status', 'Status'),
    ],
    blueprints: ['Staff badge'],
  },
  {
    id: 'transit-tickets',
    label: 'Transit tickets',
    noun: 'Tickets',
    icon: Ship,
    blurb: 'Boat, bus, train.',
    fingerprint: '/serviceKey',
    name: ['/name'],
    keys: [
      k('/bookingRef', 'Booking'),
      k('/origin', 'From'),
      k('/destination', 'To'),
      k('/departsAt', 'Departs'),
      k('/admits', 'Admits'),
      k('/status', 'Status'),
    ],
    blueprints: ['Transit ticket'],
  },
  {
    id: 'classic',
    label: 'Classic',
    noun: 'Records',
    icon: Users,
    blurb: 'Seven plain fields.',
    fingerprint: null,
    name: ['/name'],
    keys: [],
    blueprints: [],
  },
];

export const DEFAULT_DATASET = 'gym-members';

export const datasetOf = (id: unknown): DemoDataset | undefined =>
  DEMO_DATASETS.find((d) => d.id === id);

/** The dataset a Test sample came from, by the field only it carries. */
export function datasetOfSample(sample: readonly { pointer: string }[]): DemoDataset | undefined {
  const has = new Set(sample.map((f) => f.pointer));
  return (
    DEMO_DATASETS.find((d) => d.fingerprint !== null && has.has(d.fingerprint)) ??
    (has.has('/name') ? datasetOf('classic') : undefined)
  );
}

export type FieldKind = 'text' | 'number' | 'date' | 'email' | 'link' | 'toggle' | 'list';

/** A field's type from its preview: the sample carries text only. */
export function kindOf(preview: string): FieldKind {
  if (/^(true|false)$/.test(preview)) return 'toggle';
  if (/^\[.*\]$/.test(preview)) return 'list';
  if (/^-?\d+(\.\d+)?$/.test(preview)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(preview)) return 'date';
  if (!preview.includes(' ') && preview.split('@').length === 2 && preview.includes('.'))
    return 'email';
  if (/^https?:\/\//.test(preview)) return 'link';
  return 'text';
}

/** Dates and times as people read them; offsets are kept as the record states them. */
export function showValue(preview: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(preview)) return formatCalendarDate(preview);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(preview)) return formatWallTime(preview);
  if (/^\[.*\]$/.test(preview)) {
    try {
      const items = JSON.parse(preview) as unknown;
      if (Array.isArray(items)) return items.join(', ');
    } catch {
      // Not JSON after all: show it as it is.
    }
  }
  return preview;
}

/** Templates made from the dataset's blueprints come first. */
export function suggestedFirst<T extends { fromBlueprint: { name: string } | null }>(
  items: readonly T[],
  dataset: unknown,
): { suggested: T[]; rest: T[] } {
  const names = datasetOf(dataset)?.blueprints ?? [];
  const suggested = items.filter((t) => t.fromBlueprint && names.includes(t.fromBlueprint.name));
  return { suggested, rest: items.filter((t) => !suggested.includes(t)) };
}
