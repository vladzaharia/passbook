import type { PassStyle } from '../types.ts';

export const LEGACY_STYLES = [
  'generic',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
] as const;

export const FIELD_GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
  'additionalInfoFields',
  'footerFields',
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

export const STYLE_DICT_KEYS: ReadonlySet<string> = new Set([...FIELD_GROUPS, 'transitType']);

export const BARCODE_FORMATS = [
  'PKBarcodeFormatQR',
  'PKBarcodeFormatPDF417',
  'PKBarcodeFormatAztec',
  'PKBarcodeFormatCode128',
  'PKBarcodeFormatCode39',
  'PKBarcodeFormatCodabar',
  'PKBarcodeFormatEAN13',
  'PKBarcodeFormatI2of5',
] as const;
export type BarcodeFormatName = (typeof BARCODE_FORMATS)[number];
/** Rendered only on iOS 27+; earlier systems skip them and show the next entry. */
export const NEW_BARCODE_FORMATS: ReadonlySet<string> = new Set([
  'PKBarcodeFormatCode39',
  'PKBarcodeFormatCodabar',
  'PKBarcodeFormatEAN13',
  'PKBarcodeFormatI2of5',
]);
export const LEGACY_BARCODE_FORMATS: ReadonlySet<string> = new Set([
  'PKBarcodeFormatQR',
  'PKBarcodeFormatPDF417',
  'PKBarcodeFormatAztec',
]);
export const SQUARE_BARCODE_FORMATS: ReadonlySet<string> = new Set([
  'PKBarcodeFormatQR',
  'PKBarcodeFormatAztec',
]);

export const TRANSIT_TYPES = [
  'PKTransitTypeAir',
  'PKTransitTypeBoat',
  'PKTransitTypeBus',
  'PKTransitTypeGeneric',
  'PKTransitTypeTrain',
] as const;

export const DATA_DETECTOR_TYPES = [
  'PKDataDetectorTypePhoneNumber',
  'PKDataDetectorTypeLink',
  'PKDataDetectorTypeAddress',
  'PKDataDetectorTypeCalendarEvent',
] as const;
export const TEXT_ALIGNMENTS = [
  'PKTextAlignmentLeft',
  'PKTextAlignmentCenter',
  'PKTextAlignmentRight',
  'PKTextAlignmentNatural',
] as const;
export const DATE_STYLES = [
  'PKDateStyleNone',
  'PKDateStyleShort',
  'PKDateStyleMedium',
  'PKDateStyleLong',
  'PKDateStyleFull',
] as const;
export const NUMBER_STYLES = [
  'PKNumberStyleDecimal',
  'PKNumberStylePercent',
  'PKNumberStyleScientific',
  'PKNumberStyleSpellOut',
] as const;

export const FEATURED_ACTION_TYPES = [
  'viewSchedule',
  'watchTrailer',
  'listenToMusic',
  'call',
  'place',
  'addToBalance',
  'order',
  'shop',
  'membershipBenefits',
  'bookAppointment',
  'bookCar',
  'bookFlight',
  'bookStay',
  'viewOffersRewards',
] as const;

export const PREFERRED_STYLE_SCHEMES = [
  'posterEventTicket',
  'eventTicket',
  'semanticBoardingPass',
  'boardingPass',
] as const;

export const SHARING_METHODS = [
  'PKPassSharingMethodPass',
  'PKPassSharingMethodURL',
  'PKPassSharingMethodDisabled',
] as const;

export const PERSONALIZATION_FIELDS = [
  'PKPassPersonalizationFieldName',
  'PKPassPersonalizationFieldPostalCode',
  'PKPassPersonalizationFieldEmailAddress',
  'PKPassPersonalizationFieldPhoneNumber',
] as const;

export const COLOR_KEYS = [
  'foregroundColor',
  'backgroundColor',
  'labelColor',
  'stripColor',
  'footerBackgroundColor',
] as const;

/** Event guide and menu keys (poster event tickets, and per upcoming entry). */
export const EVENT_URL_KEYS = [
  'accessibilityURL',
  'addOnURL',
  'bagPolicyURL',
  'contactVenueEmail',
  'contactVenuePhoneNumber',
  'contactVenueWebsite',
  'directionsInformationURL',
  'merchandiseURL',
  'orderFoodURL',
  'parkingInformationURL',
  'purchaseParkingURL',
  'sellURL',
  'transferURL',
  'transitInformationURL',
] as const;

/** Airline service keys (semantic boarding passes). */
export const AIRLINE_URL_KEYS = [
  'changeSeatURL',
  'entertainmentURL',
  'managementURL',
  'purchaseAdditionalBaggageURL',
  'purchaseLoungeAccessURL',
  'purchaseWifiURL',
  'registerServiceAnimalURL',
  'reportLostBagURL',
  'requestWheelchairURL',
  'upgradeURL',
  'transitProviderEmail',
  'transitProviderPhoneNumber',
  'transitProviderWebsiteURL',
  'trackBagsURL',
] as const;

/** These carry an email address or phone number, not a URL. */
export const NON_URL_STRING_KEYS: ReadonlySet<string> = new Set([
  'contactVenueEmail',
  'contactVenuePhoneNumber',
  'transitProviderEmail',
  'transitProviderPhoneNumber',
]);

export type StyleTag = PassStyle | 'PET' | 'SBP';

export const MAX_RELEVANCE_ENTRIES = 10;
export const MAX_FEATURED_ACTIONS = 2;
export const MAX_RELEVANT_RANGE_MS = 24 * 3600_000;
export const MAX_NFC_MESSAGE_BYTES = 64;
export const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024;
