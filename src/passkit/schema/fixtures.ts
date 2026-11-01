import type { PassIdentity, PassJson } from '../types.ts';
import { IMAGE_RULES, type ValidatableAsset } from './validate-images.ts';

/** Shared by tests: golden passes for every style, with matching image lists. */
export const FIXTURE_ID: PassIdentity = {
  passTypeIdentifier: 'pass.example.wallet',
  teamIdentifier: 'TEAM123456',
};
export const NFC_ID: PassIdentity = { ...FIXTURE_ID, nfcEnabled: true };

export const NFC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGMUNuDp7nBd7b7xw158fzds3cf90K+mwJykYUb4ptpQFtma48NKz6bio3I9iH2jSrkMUXuiYTqTUQNaQJmHwXQ==';

const common = {
  formatVersion: 1,
  passTypeIdentifier: FIXTURE_ID.passTypeIdentifier,
  teamIdentifier: FIXTURE_ID.teamIdentifier,
  serialNumber: 'serial-1',
  organizationName: 'Acme',
  description: 'Acme pass',
  webServiceURL: 'https://wallet.example/ws',
  authenticationToken: 'a'.repeat(32),
} as const;

/** Images at the exact pixel size of the documented point size at each scale. */
export function images(...slots: string[]): ValidatableAsset[] {
  return slots.flatMap((slot) => {
    const rule = IMAGE_RULES[slot];
    const [w, h] = rule ? [rule.width[1], rule.height[1]] : [90, 90];
    return [1, 2, 3].map((scale) => ({
      name: `${slot}${scale === 1 ? '' : `@${scale}x`}.png`,
      width: w * scale,
      height: h * scale,
    }));
  });
}

const barcodes = [
  { format: 'PKBarcodeFormatCode39', message: 'ABC123', messageEncoding: 'iso-8859-1' },
  { format: 'PKBarcodeFormatCode128', message: 'ABC123', messageEncoding: 'iso-8859-1' },
];
const fields = (prefix: string) => ({
  headerFields: [{ key: `${prefix}-h`, label: 'Status', value: 'Active' }],
  primaryFields: [{ key: `${prefix}-p`, label: 'Name', value: 'Alex' }],
  secondaryFields: [{ key: `${prefix}-s`, label: 'Plan', value: 'Gold' }],
  backFields: [
    {
      key: `${prefix}-b`,
      label: 'Phone',
      value: '555-0100',
      dataDetectorTypes: ['PKDataDetectorTypePhoneNumber'],
    },
    {
      key: `${prefix}-link`,
      label: 'Portal',
      value: 'https://acme.example',
      attributedValue: '<a href="https://acme.example">Portal</a>',
    },
  ],
});

export interface Fixture {
  name: string;
  pass: PassJson;
  assets: ValidatableAsset[];
  identity: PassIdentity;
}

const iso = (s: string) => `2026-12-01T${s}:00-08:00`;

export const FIXTURES: Fixture[] = [
  {
    name: 'generic',
    pass: {
      ...common,
      generic: { ...fields('g'), auxiliaryFields: [{ key: 'g-a', label: 'ID', value: '1' }] },
      barcodes,
      locations: [{ latitude: 47.6, longitude: -122.3, relevantText: 'Club nearby' }],
    } as PassJson,
    assets: images('icon', 'logo', 'thumbnail'),
    identity: FIXTURE_ID,
  },
  {
    name: 'storeCard',
    pass: {
      ...common,
      storeCard: fields('s'),
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
      semantics: { balance: { amount: '12.50', currencyCode: 'USD' } },
    } as PassJson,
    assets: images('icon', 'logo', 'strip'),
    identity: FIXTURE_ID,
  },
  {
    name: 'coupon',
    pass: {
      ...common,
      coupon: fields('c'),
      expirationDate: iso('23:59'),
      locations: [{ latitude: 1, longitude: 2, maxDistance: 80 }],
    } as PassJson,
    assets: images('icon', 'logo', 'strip'),
    identity: FIXTURE_ID,
  },
  {
    name: 'eventTicket',
    pass: {
      ...common,
      eventTicket: {
        ...fields('e'),
        auxiliaryFields: [
          { key: 'e-a1', label: 'Gate', value: 'A' },
          { key: 'e-a2', label: 'Seat', value: '12', row: 1 },
        ],
      },
      groupingIdentifier: 'tour-2026',
      relevantDate: iso('19:00'),
      relevantDates: [{ startDate: iso('18:00'), endDate: iso('23:00') }],
      beacons: [{ proximityUUID: '8DEEFBB9-F738-4297-8040-96668BB44281', major: 1, minor: 2 }],
      semantics: { eventName: 'Show', eventStartDate: iso('19:00'), eventType: 'PKEventTypeMovie' },
    } as PassJson,
    assets: images('icon', 'logo', 'strip'),
    identity: FIXTURE_ID,
  },
  {
    name: 'boardingPass',
    pass: {
      ...common,
      boardingPass: { ...fields('b'), transitType: 'PKTransitTypeTrain' },
      groupingIdentifier: 'trip-1',
      relevantDate: iso('08:00'),
      barcodes: [{ format: 'PKBarcodeFormatPDF417', message: 'x', messageEncoding: 'iso-8859-1' }],
    } as PassJson,
    assets: images('icon', 'logo', 'footer'),
    identity: FIXTURE_ID,
  },
  {
    name: 'posterGeneric with generic fallback',
    pass: {
      ...common,
      posterGeneric: {
        headerFields: [{ key: 'g-h', label: 'Member', value: 'ABC123' }],
        primaryFields: [{ key: 'name', value: 'Alex Morgan' }],
        footerFields: [{ key: 'plan', value: 'Gold' }],
        backFields: [{ key: 'terms', label: 'Terms', value: 'None' }],
        additionalInfoFields: [{ key: 'info', label: 'Info', value: 'x' }],
      },
      generic: fields('g'),
      suppressHeaderDarkening: true,
      barcodes,
      featuredActions: [
        { identifier: 'portal', type: 'membershipBenefits', url: 'https://acme.example/in' },
        { identifier: 'club', type: 'place', placeIdentifier: 'I23C636C7300F20FD' },
      ],
      locations: [{ latitude: 47.6, longitude: -122.3, relevantText: 'Club nearby' }],
    } as PassJson,
    assets: images('icon', 'logo', 'primaryLogo', 'artwork'),
    identity: FIXTURE_ID,
  },
  {
    name: 'poster event ticket',
    pass: {
      ...common,
      eventTicket: {
        headerFields: [{ key: 'e-h', label: 'Date', value: 'Dec 1' }],
        primaryFields: [{ key: 'e-p', label: 'Event', value: 'Show' }],
        additionalInfoFields: [{ key: 'e-i', label: 'Info', value: 'Doors 18:00' }],
        backFields: [{ key: 'e-b', label: 'Terms', value: 'None' }],
      },
      preferredStyleSchemes: ['posterEventTicket', 'eventTicket'],
      nfc: {
        message: 'ticket-1',
        encryptionPublicKey: NFC_KEY,
        requiresAuthentication: true,
      },
      sharingProhibited: true,
      eventLogoText: 'Show',
      footerBackgroundColor: 'rgb(0, 0, 0)',
      useAutomaticColors: true,
      accessibilityURL: 'https://acme.example/access',
      directionsInformationURL: 'https://acme.example/directions',
      relevantDates: [{ startDate: iso('18:00'), endDate: iso('23:00') }],
      semantics: {
        eventName: 'Show',
        venueName: 'Hall',
        venueRegionName: 'Downtown',
        venueRoom: 'Main',
        eventType: 'PKEventTypeGeneric',
        seats: [{ seatSection: 'A', seatNumber: '1', seatSectionColor: 'rgb(255, 0, 0)' }],
      },
      upcomingPassInformation: [
        {
          identifier: 'e2',
          name: 'Encore',
          type: 'event',
          dateInformation: { date: iso('19:00'), timeZone: 'America/Los_Angeles' },
          isActive: false,
          backFields: [{ key: 'u-b', label: 'Note', value: 'x' }],
          URLs: { accessibilityURL: 'https://acme.example/access' },
          images: {
            headerImage: {
              URLs: [
                { URL: 'https://cdn.example/h.png', SHA256: 'a'.repeat(64), scale: 2, size: 1000 },
              ],
            },
          },
        },
      ],
    } as PassJson,
    assets: images('icon', 'logo', 'primaryLogo', 'secondaryLogo', 'artwork'),
    identity: NFC_ID,
  },
  {
    name: 'semantic boarding pass',
    pass: {
      ...common,
      boardingPass: { ...fields('b'), transitType: 'PKTransitTypeAir' },
      preferredStyleSchemes: ['semanticBoardingPass', 'boardingPass'],
      changeSeatURL: 'https://air.example/seat',
      trackBagsURL: 'https://air.example/bags',
      transitProviderEmail: 'help@air.example',
      semantics: {
        airlineCode: 'AC',
        flightNumber: 123,
        departureAirportCode: 'SEA',
        departureCityName: 'Seattle',
        departureLocationTimeZone: 'America/Los_Angeles',
        destinationAirportCode: 'YVR',
        destinationCityName: 'Vancouver',
        destinationLocationTimeZone: 'America/Vancouver',
        originalArrivalDate: iso('11:00'),
        originalBoardingDate: iso('08:00'),
        originalDepartureDate: iso('09:00'),
        passengerName: { givenName: 'Alex', familyName: 'Morgan' },
        passengerCapabilities: ['PKPassengerCapabilityPriorityBoarding'],
        passengerServiceSSRs: ['WCHR'],
      },
    } as PassJson,
    assets: images('icon', 'primaryLogo', 'logo', 'footer'),
    identity: FIXTURE_ID,
  },
];
