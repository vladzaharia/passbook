import { type PaperKind, type PaperSize, resolvePaper } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { PrintSheet } from './pdf-render.ts';

export const SAMPLE_CODE = 'PK7QM3XRTWA2D5HJN6BV4CEYLZG';

/** An event ticket with every part a printed ticket draws. */
export const ADMISSION: PaperContent = {
  brand: 'Harbour Lights Festival',
  kind: 'admission',
  ink: 'colour',
  colors: { bg: '#5e0636', fg: '#ffffff', label: '#f6c5d6' },
  logo: true,
  title: 'Harbour Lights: Night Two',
  kicker: 'Event ticket',
  noun: 'ticket',
  once: true,
  start: '2027-02-13T19:30:00+13:00',
  doors: '2027-02-13T18:30:00+13:00',
  end: '2027-02-13T22:30:00+13:00',
  zone: 'Pacific/Auckland',
  zoneNamed: true,
  venue: 'Pier 9 Amphitheatre',
  address: '9 Wharf Road, Wellington 6011',
  room: 'Main lawn',
  holder: 'Maya Okafor',
  type: 'General admission',
  seat: { section: 'B', row: '4', seat: '12' },
  facts: [
    { label: 'Section', text: 'B' },
    { label: 'Row', text: '4' },
    { label: 'Seat', text: '12' },
  ],
  bring: ['This page or your phone ticket', 'Photo ID in the name Maya Okafor'],
  help: ['hello@harbourlights.nz', '+64 4 555 0123'],
  terms: 'No re-entry. Ticket is non-transferable.',
  extras: [],
  info: {},
  photo: false,
};

const PERMIT: PaperContent = {
  ...ADMISSION,
  kind: 'permit',
  kicker: 'Parking permit',
  type: 'Monthly',
  validUntil: '2027-12-31T23:59:00+00:00',
  zone: 'UTC',
  zoneNamed: false,
  hero: { zone: 'C', plate: 'AB12 CDE' },
  facts: [{ label: 'Bay', text: '14' }],
};
const COUPON: PaperContent = {
  ...ADMISSION,
  kind: 'coupon',
  kicker: 'Coupon',
  noun: 'pass',
  once: false,
  validUntil: '2027-01-31T23:59:00+00:00',
  zone: 'UTC',
  zoneNamed: false,
  hero: { offer: '20% off', offerNote: 'Your next order of $30 or more' },
};
const MEMBERSHIP: PaperContent = {
  ...ADMISSION,
  kind: 'membership',
  kicker: 'Membership',
  noun: 'pass',
  once: false,
  type: 'All-Inclusive',
  validUntil: '2027-12-31T23:59:00+00:00',
};

type Optional = 'venue' | 'address' | 'room' | 'seat' | 'doors' | 'end' | 'directions';
const without = (c: PaperContent, ...keys: Optional[]): PaperContent => {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
};
/** The shared start of the trip, stay and ID fixtures: no venue, no event wording. */
const PLAIN: PaperContent = {
  ...without(ADMISSION, 'venue', 'address', 'room', 'seat', 'doors', 'end'),
  bring: ['This page or your phone pass'],
  terms: 'Be there on time.',
  facts: [],
};

const JOURNEY: PaperContent = {
  ...PLAIN,
  kind: 'journey',
  kicker: 'Boarding pass',
  noun: 'pass',
  title: 'SFO – JFK',
  zone: 'America/Los_Angeles',
  start: '2030-06-01T08:00:00-07:00',
  holder: 'Alex Morgan',
  seat: { seat: '14A' },
  facts: [
    { label: 'Gate', text: 'B12' },
    { label: 'Seat', text: '14A' },
    { label: 'Group', text: '3' },
  ],
  info: {
    from: 'SFO',
    fromCity: 'San Francisco',
    to: 'JFK',
    toCity: 'New York',
    vehicle: 'WA100',
    vehicleLabel: 'Flight',
    gate: 'B12',
    gateLabel: 'Gate',
    boards: '2030-06-01T07:15:00-07:00',
    group: '3',
  },
};
const CONTENT: Record<PaperKind, PaperContent> = {
  journey: JOURNEY,
  booking: {
    ...PLAIN,
    kind: 'booking',
    bring: ['This page or your phone pass'],
    kicker: 'Booking',
    noun: 'pass',
    title: 'Cut and colour',
    zone: 'America/New_York',
    start: '2030-11-24T09:30:00-05:00',
    venue: 'Soho',
    facts: [
      { label: 'With', text: 'Sam' },
      { label: 'Where', text: 'Soho' },
    ],
    info: { with: 'Sam' },
  },
  stay: {
    ...PLAIN,
    kind: 'stay',
    bring: ['This page or your phone pass'],
    kicker: 'Hotel stay',
    noun: 'pass',
    title: 'Ana Rivera',
    zone: 'America/Los_Angeles',
    start: '2030-11-18T15:00:00-08:00',
    end: '2030-11-21T11:00:00-08:00',
    room: '1204',
    holder: 'Ana Rivera',
    facts: [
      { label: 'Room', text: '1204' },
      { label: 'Nights', text: '3' },
    ],
    info: { nights: '3', included: 'Breakfast: Included' },
  },
  badge: {
    ...PLAIN,
    kind: 'badge',
    bring: ['Your badge or phone pass'],
    kicker: 'Visitor pass',
    noun: 'pass',
    title: 'Leo Brandt',
    holder: 'Leo Brandt',
    photo: true,
    start: '2030-11-18T09:30:00-08:00',
    validUntil: '2030-11-18T17:00:00-08:00',
    zone: 'America/Los_Angeles',
    info: { company: 'Acme Ltd', host: 'Priya Shah', goTo: 'Floor 3, Oslo' },
    facts: [],
  },
  credential: {
    ...PLAIN,
    kind: 'credential',
    bring: ['Your card or phone pass'],
    kicker: 'Credential',
    noun: 'card',
    title: 'CPR / AED Provider',
    holder: 'Ana Rivera',
    photo: true,
    validUntil: '2028-03-15T00:00:00Z',
    zone: 'UTC',
    info: { number: '77310', credential: 'CPR / AED Provider', issued: '2026-03-15T00:00:00Z' },
    facts: [],
  },
  admission: ADMISSION,
  permit: PERMIT,
  coupon: COUPON,
  membership: MEMBERSHIP,
  pickup: { ...ADMISSION, kind: 'pickup', kicker: 'Order pickup', items: ['Roast chicken'] },
};

/** A ready-to-draw sheet of a kind and size; `paper` and `content` override the defaults. */
export function sheet(
  kind: PaperKind,
  size: PaperSize,
  over: {
    paper?: object;
    content?: Partial<PaperContent>;
    mode?: 'live' | 'test';
    mark?: PrintSheet['mark'];
    images?: PrintSheet['images'];
  } = {},
): PrintSheet {
  const barcode = kind === 'coupon' ? 'code128' : 'qr';
  const design = resolvePaper({ schema: 1, size, barcode, ...over.paper });
  return {
    design,
    content: { ...CONTENT[kind], ...over.content },
    code: SAMPLE_CODE,
    mark: over.mark ?? 'full',
    issued: { generation: 2, at: '2026-11-19T01:02:00Z' },
    ...(over.mode ? { mode: over.mode } : {}),
    ...(over.images ? { images: over.images } : {}),
  };
}
