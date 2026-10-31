import type { Json } from '../types.ts';
import type {
  BARCODE_FORMATS,
  DATA_DETECTOR_TYPES,
  DATE_STYLES,
  FEATURED_ACTION_TYPES,
  NUMBER_STYLES,
  PERSONALIZATION_FIELDS,
  PREFERRED_STYLE_SCHEMES,
  SHARING_METHODS,
  TEXT_ALIGNMENTS,
  TRANSIT_TYPES,
} from './constants.ts';
import type { SemanticTags } from './semantic-types.ts';

export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];
export type TransitType = (typeof TRANSIT_TYPES)[number];
export type DataDetectorType = (typeof DATA_DETECTOR_TYPES)[number];
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
export type DateStyle = (typeof DATE_STYLES)[number];
export type NumberStyle = (typeof NUMBER_STYLES)[number];
export type FeaturedActionType = (typeof FEATURED_ACTION_TYPES)[number];
export type PreferredStyleScheme = (typeof PREFERRED_STYLE_SCHEMES)[number];
export type SharingMethod = (typeof SHARING_METHODS)[number];
export type PersonalizationFieldName = (typeof PERSONALIZATION_FIELDS)[number];

/** Field dictionary. Unknown keys stay allowed and produce a validator warning. */
export interface PassField {
  key: string;
  value: Json;
  label?: string;
  /** Only `<a href>` is supported. */
  attributedValue?: Json;
  /** Must contain `%@`. */
  changeMessage?: string;
  /** Back fields only. `[]` disables detection. */
  dataDetectorTypes?: DataDetectorType[] | string[];
  /** Not allowed on primary and back fields. */
  textAlignment?: TextAlignment | string;
  dateStyle?: DateStyle | string;
  timeStyle?: DateStyle | string;
  isRelative?: boolean;
  ignoresTimeZone?: boolean;
  /** Number values only; exclusive with numberStyle. */
  currencyCode?: string;
  numberStyle?: NumberStyle | string;
  /** Second auxiliary row; eventTicket auxiliaryFields only. */
  row?: 0 | 1;
  semantics?: SemanticTags;
  _id?: string;
  [key: string]: Json | undefined;
}

export interface PassFields {
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
  /** Poster event tickets and poster generic (iOS 18+). */
  additionalInfoFields?: PassField[];
  /** Poster generic only (iOS 27); only the first is shown. */
  footerFields?: PassField[];
  /** boardingPass only; required there. */
  transitType?: TransitType | string;
  [key: string]: Json | PassField[] | undefined;
}

export interface PassBarcode {
  format: BarcodeFormat | (string & {});
  message: string;
  messageEncoding: string;
  altText?: string;
}

export interface PassLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  relevantText?: string;
  /** Meters, > 0. Can only shrink the default radius. Honoured per location, not at the root. */
  maxDistance?: number;
}

export interface PassBeacon {
  proximityUUID: string;
  major?: number;
  minor?: number;
  relevantText?: string;
  name?: string;
}

/** Either `{startDate, endDate}` or a single moment (`date` from iOS 26, `relevantDate` for iOS 18). */
export interface RelevantDateEntry {
  startDate?: string;
  endDate?: string;
  date?: string;
  relevantDate?: string;
}

export interface PassNfc {
  /** At most 64 bytes. */
  message: string;
  /** Base64 X.509 SPKI, ECDH P-256, no PEM header. */
  encryptionPublicKey: string;
  requiresAuthentication?: boolean;
}

export interface FeaturedAction {
  identifier: string;
  type: FeaturedActionType | (string & {});
  /** Required unless type is `place`. `tel:` for `call`. */
  url?: string;
  /** Required for `place`; replaces `url`. */
  placeIdentifier?: string;
  _id?: string;
  [key: string]: Json | undefined;
}

export interface PassSharing {
  method?: SharingMethod;
  url?: string;
  text?: string;
}

export interface RemoteImageUrl {
  URL: string;
  SHA256: string;
  scale?: 1 | 2 | 3;
  /** Bytes, at most 2 MB. */
  size: number;
}

export interface RemoteImage {
  URLs?: RemoteImageUrl[];
  reuseExisting?: boolean;
}

export interface UpcomingEventUrls {
  accessibilityURL?: string;
  addOnURL?: string;
  bagPolicyURL?: string;
  contactVenueEmail?: string;
  contactVenuePhoneNumber?: string;
  contactVenueWebsite?: string;
  directionsInformationURL?: string;
  merchandiseURL?: string;
  orderFoodURL?: string;
  parkingInformationURL?: string;
  purchaseParkingURL?: string;
  sellURL?: string;
  transferURL?: string;
  transitInformationURL?: string;
}

export interface UpcomingPassInformationEntry {
  identifier: string;
  name: string;
  type: 'event';
  dateInformation?: {
    date?: string;
    ignoreTimeComponents?: boolean;
    isAllDay?: boolean;
    isUnannounced?: boolean;
    isUndetermined?: boolean;
    timeZone?: string;
  };
  isActive?: boolean;
  semantics?: SemanticTags;
  additionalInfoFields?: PassField[];
  backFields?: PassField[];
  URLs?: UpcomingEventUrls;
  images?: { headerImage?: RemoteImage; venueMap?: RemoteImage };
  auxiliaryStoreIdentifiers?: number[];
}

/** personalization.json */
export interface PersonalizationJson {
  requiredPersonalizationFields: PersonalizationFieldName[];
  description: string;
  termsAndConditions?: string;
}

/** Event guide keys (poster event tickets, iOS 18) and airline service keys (iOS 26). */
export interface PassUrlKeys extends UpcomingEventUrls {
  changeSeatURL?: string;
  entertainmentURL?: string;
  managementURL?: string;
  purchaseAdditionalBaggageURL?: string;
  purchaseLoungeAccessURL?: string;
  purchaseWifiURL?: string;
  registerServiceAnimalURL?: string;
  reportLostBagURL?: string;
  requestWheelchairURL?: string;
  upgradeURL?: string;
  transitProviderEmail?: string;
  transitProviderPhoneNumber?: string;
  transitProviderWebsiteURL?: string;
  /** iOS 26.1 */
  trackBagsURL?: string;
  businessChatIdentifier?: string;
}

/** pass.json. Known keys are typed; anything else is allowed and produces a validator warning. */
export interface PassJson extends PassUrlKeys {
  formatVersion: 1;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;

  // Styles
  generic?: PassFields;
  /** iOS 27. Pair with a legacy style for earlier systems. */
  posterGeneric?: PassFields;
  storeCard?: PassFields;
  coupon?: PassFields;
  eventTicket?: PassFields;
  boardingPass?: PassFields;
  preferredStyleSchemes?: (PreferredStyleScheme | (string & {}))[];

  // Appearance
  logoText?: string;
  /** iOS 18.1, poster event tickets. */
  eventLogoText?: string;
  foregroundColor?: string;
  backgroundColor?: string;
  labelColor?: string;
  /** Undocumented. */
  stripColor?: string;
  footerBackgroundColor?: string;
  useAutomaticColors?: boolean;
  suppressHeaderDarkening?: boolean;
  /** Pass Builder only, unverified. */
  logoSymbolName?: string;
  /** No-op since iOS 7. */
  suppressStripShine?: boolean;
  groupingIdentifier?: string;

  // Barcodes
  /** Deprecated (iOS 8 and earlier). */
  barcode?: PassBarcode;
  barcodes?: PassBarcode[];

  // Relevance
  locations?: PassLocation[];
  /** Root value is reportedly ignored; set it per location. */
  maxDistance?: number;
  beacons?: PassBeacon[];
  /** Deprecated in iOS 18; still read by earlier systems. */
  relevantDate?: string;
  relevantDates?: RelevantDateEntry[];

  // Lifecycle
  expirationDate?: string;
  voided?: boolean;

  // Web service and apps
  webServiceURL?: string;
  authenticationToken?: string;
  associatedStoreIdentifiers?: number[];
  appLaunchURL?: string;
  auxiliaryStoreIdentifiers?: number[];
  userInfo?: Json;

  // Sharing
  sharingProhibited?: boolean;
  /** Undocumented. */
  sharing?: PassSharing;

  nfc?: PassNfc;
  semantics?: SemanticTags;
  /** iOS 27. At most two; not shown on poster event tickets and semantic boarding passes. */
  featuredActions?: FeaturedAction[];
  /** iOS 26, poster event tickets. */
  upcomingPassInformation?: UpcomingPassInformationEntry[];

  [key: string]: unknown;
}
