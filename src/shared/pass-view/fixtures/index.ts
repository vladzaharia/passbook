import type { PassJson } from '../../../passkit/types.ts';

const base = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.test.example',
  teamIdentifier: 'TEAM123456',
  serialNumber: 'SN-1',
  organizationName: 'Example Org',
  description: 'Example pass',
} as const;

const qr = {
  format: 'PKBarcodeFormatQR',
  message: 'MEMBER-0001',
  messageEncoding: 'iso-8859-1',
  altText: 'MEMBER-0001',
};

const backFields = [
  {
    key: 'terms',
    label: 'Terms',
    value: 'Terms apply.',
    attributedValue: 'See <a href="https://example.com/terms">terms</a>.',
  },
  { key: 'phone', label: 'Support', value: 'Call +1 555 010 9999 or help@example.com' },
];

export const generic: PassJson = {
  ...base,
  logoText: 'Example',
  backgroundColor: 'rgb(30, 60, 120)',
  foregroundColor: 'rgb(255, 255, 255)',
  labelColor: 'rgb(200, 210, 230)',
  barcodes: [qr],
  generic: {
    headerFields: [
      { key: 'tier', label: 'Tier', value: 'Gold', textAlignment: 'PKTextAlignmentRight' },
    ],
    primaryFields: [{ key: 'name', label: 'Member', value: 'Ada Lovelace' }],
    secondaryFields: [
      {
        key: 'since',
        label: 'Since',
        value: '2024-03-01T00:00:00Z',
        dateStyle: 'PKDateStyleMedium',
      },
    ],
    auxiliaryFields: [
      { key: 'points', label: 'Points', value: 12500, numberStyle: 'PKNumberStyleDecimal' },
    ],
    backFields,
  },
};

export const storeCard: PassJson = {
  ...base,
  logoText: 'Cafe',
  backgroundColor: 'rgb(60, 40, 30)',
  foregroundColor: 'rgb(255, 255, 255)',
  barcodes: [{ ...qr, format: 'PKBarcodeFormatPDF417' }],
  storeCard: {
    headerFields: [{ key: 'level', label: 'Level', value: 'Silver' }],
    primaryFields: [{ key: 'balance', label: 'Balance', value: 23.5, currencyCode: 'USD' }],
    secondaryFields: [{ key: 'id', label: 'Card', value: '0042' }],
    auxiliaryFields: [
      {
        key: 'exp',
        label: 'Expires',
        value: '2027-01-01T00:00:00Z',
        dateStyle: 'PKDateStyleShort',
      },
    ],
    backFields,
  },
};

export const coupon: PassJson = {
  ...base,
  logoText: 'Deals',
  backgroundColor: 'rgb(200, 40, 60)',
  foregroundColor: 'rgb(255, 255, 255)',
  barcodes: [{ ...qr, format: 'PKBarcodeFormatCode128', message: 'COUPON123' }],
  coupon: {
    headerFields: [{ key: 'off', label: 'Offer', value: 'Spring' }],
    primaryFields: [{ key: 'discount', label: 'Discount', value: '20% off' }],
    secondaryFields: [{ key: 'code', label: 'Code', value: 'SPRING20' }],
    backFields,
  },
};

export const eventTicket: PassJson = {
  ...base,
  logoText: 'Live',
  backgroundColor: 'rgb(20, 20, 40)',
  foregroundColor: 'rgb(255, 255, 255)',
  barcodes: [qr],
  eventTicket: {
    headerFields: [{ key: 'gate', label: 'Gate', value: 'B' }],
    primaryFields: [{ key: 'event', label: 'Event', value: 'Open Air Concert' }],
    secondaryFields: [{ key: 'loc', label: 'Venue', value: 'Main Park' }],
    auxiliaryFields: [
      { key: 'sec', label: 'Section', value: '12' },
      { key: 'seat', label: 'Seat', value: '7', row: 1 },
    ],
    backFields,
  },
};

export const posterEventTicket: PassJson = {
  ...eventTicket,
  preferredStyleSchemes: ['posterEventTicket', 'eventTicket'],
  semantics: {
    eventName: 'Concert',
    venueName: 'Hall',
    venueRegionName: 'Cupertino, CA',
    venueRoom: 'Main',
  },
  featuredActions: [
    { identifier: 'a1', type: 'viewSchedule', url: 'https://example.com/schedule' },
  ],
};

export const boardingPass: PassJson = {
  ...base,
  logoText: 'Air Example',
  backgroundColor: 'rgb(10, 80, 140)',
  foregroundColor: 'rgb(255, 255, 255)',
  barcodes: [{ ...qr, format: 'PKBarcodeFormatAztec', message: 'BOARDING-1' }],
  boardingPass: {
    transitType: 'PKTransitTypeAir',
    headerFields: [{ key: 'gate', label: 'Gate', value: 'A12' }],
    primaryFields: [
      { key: 'from', label: 'San Francisco', value: 'SFO' },
      { key: 'to', label: 'Tokyo', value: 'HND' },
    ],
    secondaryFields: [{ key: 'pax', label: 'Passenger', value: 'Ada Lovelace' }],
    auxiliaryFields: [{ key: 'seat', label: 'Seat', value: '23A' }],
    backFields,
  },
};

export const posterGeneric: PassJson = {
  ...base,
  backgroundColor: 'rgb(0, 0, 0)',
  foregroundColor: 'rgb(255, 255, 255)',
  barcodes: [{ ...qr, format: 'PKBarcodeFormatCode39', message: 'ABC123' }, qr],
  featuredActions: [
    { identifier: 'a1', type: 'call', url: 'tel:+15550109999' },
    { identifier: 'a2', type: 'place', placeIdentifier: 'I63802885C9A9F36B' },
    { identifier: 'a3', type: 'shop', url: 'https://example.com/shop' },
  ],
  posterGeneric: {
    headerFields: [{ key: 'id', label: 'ID', value: 'M-0001' }],
    primaryFields: [
      { key: 'name', value: 'Ada Lovelace' },
      { key: 'club', label: 'Home club', value: 'Downtown' },
    ],
    footerFields: [{ key: 'plan', label: 'Plan', value: 'Annual' }],
    backFields,
    additionalInfoFields: [{ key: 'info', label: 'Hours', value: '6am to 10pm' }],
  },
  generic: {
    headerFields: [{ key: 'id', label: 'ID', value: 'M-0001' }],
    primaryFields: [{ key: 'name', label: 'Member', value: 'Ada Lovelace' }],
    backFields,
  },
};

export const fixtures = {
  generic,
  storeCard,
  coupon,
  eventTicket,
  posterEventTicket,
  boardingPass,
  posterGeneric,
};

export const assets: Record<string, string> = {
  'icon.png': '/a/icon.png',
  'icon@2x.png': '/a/icon@2x.png',
  'logo.png': '/a/logo.png',
  'logo@2x.png': '/a/logo@2x.png',
  'logo@3x.png': '/a/logo@3x.png',
  'strip@2x.png': '/a/strip@2x.png',
  'artwork@2x.png': '/a/artwork@2x.png',
  'primaryLogo@2x.png': '/a/primaryLogo@2x.png',
};
