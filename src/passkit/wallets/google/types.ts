/**
 * Typed bodies of the Google Wallet REST API (google-wallet.md section 1; architecture 3). A
 * compiler returns bodies without ids: the runtime adds the class `id` and `callbackOptions`, and
 * the object `id` and `classId`.
 */
import type { GOOGLE_TYPES } from '../../template/wallets/schema.ts';

export type GoogleType = (typeof GOOGLE_TYPES)[number];

export interface GoogleTranslated {
  language: string;
  value: string;
}
export interface GoogleLocalized {
  defaultValue: GoogleTranslated;
  translatedValues?: GoogleTranslated[];
}
export interface GoogleImage {
  sourceUri: { uri: string };
  contentDescription: GoogleLocalized;
}
export interface GoogleTextModule {
  id: string;
  header?: string;
  body?: string;
  localizedHeader?: GoogleLocalized;
  localizedBody?: GoogleLocalized;
}
export interface GoogleLinkUri {
  id: string;
  uri: string;
  description: string;
}
export interface GoogleLinksModule {
  uris: GoogleLinkUri[];
}
export interface GoogleImageModule {
  id: string;
  mainImage: GoogleImage;
}
export interface GoogleBarcode {
  type: 'QR_CODE' | 'PDF_417' | 'AZTEC' | 'CODE_128' | 'CODE_39' | 'CODABAR' | 'EAN_13' | 'ITF_14';
  renderEncoding: 'UTF_8';
  value: string;
  alternateText?: string;
}
export interface GoogleDateTime {
  date: string;
}
export interface GoogleTimeInterval {
  start?: GoogleDateTime;
  end?: GoogleDateTime;
}
export interface GoogleMessage {
  id: string;
  header: string;
  body: string;
  messageType: 'TEXT' | 'TEXT_AND_NOTIFY';
}
export interface GoogleLatLong {
  latitude: number;
  longitude: number;
}
export interface GoogleMoney {
  /** Millionths of the unit, as a decimal string (int64). */
  micros: string;
  currencyCode: string;
}

export type GoogleState = 'ACTIVE' | 'INACTIVE';
/** One holder, all their devices: the bearer save link (google-wallet.md section 7, G6). */
export type GoogleHolders = 'ONE_USER_ALL_DEVICES';

/** Fields every object body can carry. `id` and `classId` are added by the runtime. */
export interface GoogleObjectCommon {
  state: GoogleState;
  barcode?: GoogleBarcode;
  validTimeInterval?: GoogleTimeInterval;
  textModulesData?: GoogleTextModule[];
  linksModuleData?: GoogleLinksModule;
  imageModulesData?: GoogleImageModule[];
  messages?: GoogleMessage[];
}
/** Fields every class body can carry. `id` is added by the runtime. */
export interface GoogleClassCommon {
  multipleDevicesAndHoldersAllowedStatus: GoogleHolders;
  hexBackgroundColor?: string;
  heroImage?: GoogleImage;
}
export interface GoogleTypedClassCommon extends GoogleClassCommon {
  issuerName: string;
  /** Typed classes go through Google review (owner answer Q16). */
  reviewStatus: 'UNDER_REVIEW';
}

export type GoogleGenericClass = Pick<GoogleClassCommon, 'multipleDevicesAndHoldersAllowedStatus'>;
export interface GoogleGenericObject extends GoogleObjectCommon {
  genericType: 'GENERIC_OTHER';
  cardTitle: GoogleLocalized;
  header: GoogleLocalized;
  subheader?: GoogleLocalized;
  logo?: GoogleImage;
  wideLogo?: GoogleImage;
  heroImage?: GoogleImage;
  hexBackgroundColor?: string;
  merchantLocations?: GoogleLatLong[];
  notifications?: { upcomingNotification: { enableNotification: true } };
}

export interface GoogleEventClass extends GoogleTypedClassCommon {
  eventName: GoogleLocalized;
  venue?: { name?: GoogleLocalized; address?: GoogleLocalized };
  dateTime?: { start?: string; end?: string; doorsOpen?: string };
  eventId?: string;
  logo?: GoogleImage;
  wideLogo?: GoogleImage;
}
export interface GoogleEventObject extends GoogleObjectCommon {
  ticketHolderName?: string;
  ticketNumber?: string;
  reservationInfo?: { confirmationCode: string };
  seatInfo?: Partial<Record<'seat' | 'row' | 'section' | 'gate', GoogleLocalized>>;
  locations?: GoogleLatLong[];
}

export interface GooglePoints {
  label: string;
  balance: { int: number } | { double: number } | { string: string } | { money: GoogleMoney };
}
export interface GoogleLoyaltyClass extends GoogleTypedClassCommon {
  programName: string;
  programLogo: GoogleImage;
  wideProgramLogo?: GoogleImage;
  accountIdLabel?: string;
  accountNameLabel?: string;
}
export interface GoogleLoyaltyObject extends GoogleObjectCommon {
  accountId?: string;
  accountName?: string;
  loyaltyPoints?: GooglePoints;
  secondaryLoyaltyPoints?: GooglePoints;
  locations?: GoogleLatLong[];
}

export interface GoogleGiftClass extends GoogleTypedClassCommon {
  merchantName: string;
  programLogo: GoogleImage;
  wideProgramLogo?: GoogleImage;
  cardNumberLabel?: string;
  pinLabel?: string;
  balanceLabel?: string;
}
export interface GoogleGiftObject extends GoogleObjectCommon {
  cardNumber: string;
  pin?: string;
  balance?: GoogleMoney;
  locations?: GoogleLatLong[];
}

export type GoogleRedemption = 'ONLINE' | 'INSTORE' | 'BOTH';
export interface GoogleOfferClass extends GoogleTypedClassCommon {
  provider: string;
  title: string;
  localizedTitle?: GoogleLocalized;
  redemptionChannel: GoogleRedemption;
  details?: string;
  localizedDetails?: GoogleLocalized;
  finePrint?: string;
  localizedFinePrint?: GoogleLocalized;
  titleImage?: GoogleImage;
  wideTitleImage?: GoogleImage;
}
export interface GoogleOfferObject extends GoogleObjectCommon {
  locations?: GoogleLatLong[];
}

export interface GoogleBodies {
  generic: { classBody: GoogleGenericClass; objectBody: GoogleGenericObject };
  event: { classBody: GoogleEventClass; objectBody: GoogleEventObject };
  loyalty: { classBody: GoogleLoyaltyClass; objectBody: GoogleLoyaltyObject };
  gift: { classBody: GoogleGiftClass; objectBody: GoogleGiftObject };
  offer: { classBody: GoogleOfferClass; objectBody: GoogleOfferObject };
}
