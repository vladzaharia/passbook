/** Semantic tag model. The runtime table below drives both the TypeScript type and the validator. */

export type EventType =
  | 'PKEventTypeGeneric'
  | 'PKEventTypeLivePerformance'
  | 'PKEventTypeMovie'
  | 'PKEventTypeSports'
  | 'PKEventTypeConference'
  | 'PKEventTypeConvention'
  | 'PKEventTypeWorkshop'
  | 'PKEventTypeSocialGathering';

export const EVENT_TYPES: readonly EventType[] = [
  'PKEventTypeGeneric',
  'PKEventTypeLivePerformance',
  'PKEventTypeMovie',
  'PKEventTypeSports',
  'PKEventTypeConference',
  'PKEventTypeConvention',
  'PKEventTypeWorkshop',
  'PKEventTypeSocialGathering',
];

export type SecurityProgram =
  | 'PKTransitSecurityProgramTSAPreCheck'
  | 'PKTransitSecurityProgramTSAPreCheckTouchlessID'
  | 'PKTransitSecurityProgramOSS'
  | 'PKTransitSecurityProgramITI'
  | 'PKTransitSecurityProgramITD'
  | 'PKTransitSecurityProgramGlobalEntry'
  | 'PKTransitSecurityProgramCLEAR';

export const SECURITY_PROGRAMS: readonly SecurityProgram[] = [
  'PKTransitSecurityProgramTSAPreCheck',
  'PKTransitSecurityProgramTSAPreCheckTouchlessID',
  'PKTransitSecurityProgramOSS',
  'PKTransitSecurityProgramITI',
  'PKTransitSecurityProgramITD',
  'PKTransitSecurityProgramGlobalEntry',
  'PKTransitSecurityProgramCLEAR',
];

export type PassengerCapability =
  | 'PKPassengerCapabilityPreboarding'
  | 'PKPassengerCapabilityPriorityBoarding'
  | 'PKPassengerCapabilityCarryon'
  | 'PKPassengerCapabilityPersonalItem'
  | 'PKPassengerCapabilityLapInfant';

export const PASSENGER_CAPABILITIES: readonly PassengerCapability[] = [
  'PKPassengerCapabilityPreboarding',
  'PKPassengerCapabilityPriorityBoarding',
  'PKPassengerCapabilityCarryon',
  'PKPassengerCapabilityPersonalItem',
  'PKPassengerCapabilityLapInfant',
];

export const SERVICE_SSRS = [
  'PETC',
  'SVAN',
  'UMNR',
  'WCBD',
  'WCBW',
  'WCHC',
  'WCHR',
  'WCHS',
  'WCLB',
  'WCMP',
  'WCOB',
] as const;

export type CurrencyAmount = { amount: string; currencyCode: string };
export type EventDateInfo = {
  date?: string;
  ignoreTimeComponents?: boolean;
  timeZone?: string;
  /** iOS 18.1 */
  unannounced?: boolean;
  /** iOS 18.1 */
  undetermined?: boolean;
};
export type SemanticLocation = { latitude: number; longitude: number };
export type PersonNameComponents = {
  familyName?: string;
  givenName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  nickname?: string;
  phoneticRepresentation?: PersonNameComponents;
};
export type SemanticSeat = {
  seatDescription?: string;
  seatIdentifier?: string;
  seatNumber?: string;
  seatRow?: string;
  seatSection?: string;
  seatType?: string;
  seatAisle?: string;
  seatLevel?: string;
  seatSectionColor?: string;
};
export type WifiNetwork = {
  ssid: string;
  password: string;
  captiveToken?: string;
  captiveTokenAuthURL?: string;
};
export type AirPlayEntry = { airPlayDeviceGroupToken: string };

export type SemanticKind =
  | 'ls'
  | 'date'
  | 'bool'
  | 'number'
  | 'tz'
  | 'lsArray'
  | 'stringArray'
  | 'dateInfo'
  | 'location'
  | 'person'
  | 'seats'
  | 'currency'
  | 'wifi'
  | 'airplay'
  | 'eventType'
  | 'securityPrograms'
  | 'capabilities'
  | 'serviceSSRs'
  | 'infoSSRs';

interface KindTypes {
  ls: string;
  date: string;
  bool: boolean;
  number: number;
  tz: string;
  lsArray: string[];
  stringArray: string[];
  dateInfo: EventDateInfo;
  location: SemanticLocation;
  person: PersonNameComponents;
  seats: SemanticSeat[];
  currency: CurrencyAmount;
  wifi: WifiNetwork[];
  airplay: AirPlayEntry[];
  eventType: EventType;
  securityPrograms: SecurityProgram[];
  capabilities: PassengerCapability[];
  serviceSSRs: (typeof SERVICE_SSRS)[number][];
  infoSSRs: 'INFT'[];
}

const group = <const K extends SemanticKind, const T extends readonly string[]>(kind: K, keys: T) =>
  Object.fromEntries(keys.map((key) => [key, kind])) as Record<T[number], K>;

/** Every documented tag (104) plus the undocumented aliases the catalog says to accept. */
export const SEMANTIC_KINDS = {
  ...group('ls', [
    'eventName',
    'genre',
    'venueName',
    'venueRoom',
    'venueEntrance',
    'venuePhoneNumber',
    'awayTeamAbbreviation',
    'awayTeamLocation',
    'awayTeamName',
    'homeTeamAbbreviation',
    'homeTeamLocation',
    'homeTeamName',
    'leagueAbbreviation',
    'leagueName',
    'sportName',
    'additionalTicketAttributes',
    'admissionLevel',
    'admissionLevelAbbreviation',
    'attendeeName',
    'entranceDescription',
    'venueEntranceDoor',
    'venueEntranceGate',
    'venueEntrancePortal',
    'venueRegionName',
    'airlineCode',
    'flightCode',
    'boardingGroup',
    'boardingSequenceNumber',
    'carNumber',
    'confirmationNumber',
    'departureAirportCode',
    'departureAirportName',
    'departureGate',
    'departureLocationDescription',
    'departurePlatform',
    'departureStationName',
    'departureTerminal',
    'destinationAirportCode',
    'destinationAirportName',
    'destinationGate',
    'destinationLocationDescription',
    'destinationPlatform',
    'destinationStationName',
    'destinationTerminal',
    'membershipProgramName',
    'membershipProgramNumber',
    'membershipProgramStatus',
    'priorityStatus',
    'securityScreening',
    'transitProvider',
    'transitStatus',
    'transitStatusReason',
    'vehicleName',
    'vehicleNumber',
    'vehicleType',
    'boardingZone',
    'departureCityName',
    'destinationCityName',
    'ticketFareClass',
    'internationalDocumentsVerifiedDeclarationName',
    // Undocumented
    'venuePlaceID',
    'eventLiveMessage',
    'airlineLoungePlaceID',
  ]),
  ...group('date', [
    'eventStartDate',
    'eventEndDate',
    'venueBoxOfficeOpenDate',
    'venueCloseDate',
    'venueDoorsOpenDate',
    'venueFanZoneOpenDate',
    'venueGatesOpenDate',
    'venueOpenDate',
    'venueParkingLotsOpenDate',
    'originalArrivalDate',
    'currentArrivalDate',
    'originalBoardingDate',
    'currentBoardingDate',
    'originalDepartureDate',
    'currentDepartureDate',
  ]),
  ...group('bool', ['silenceRequested', 'tailgatingAllowed', 'internationalDocumentsAreVerified']),
  ...group('number', ['duration', 'flightNumber']),
  ...group('tz', [
    'departureLocationTimeZone',
    'destinationLocationTimeZone',
    // Pass Builder spelling; iOS 26 accepts both
    'departureAirportTimeZone',
    'destinationAirportTimeZone',
  ]),
  ...group('lsArray', ['performerNames', 'artistIDs', 'albumIDs', 'playlistIDs', 'loungePlaceIDs']),
  ...group('stringArray', ['passengerAirlineSSRs']),
  ...group('securityPrograms', [
    'departureLocationSecurityPrograms',
    'destinationLocationSecurityPrograms',
    'passengerEligibleSecurityPrograms',
    'departureAirportSecurityPrograms',
    'destinationAirportSecurityPrograms',
  ]),
  ...group('location', ['venueLocation', 'departureLocation', 'destinationLocation']),
  ...group('currency', ['totalPrice', 'balance']),
  eventType: 'eventType',
  eventStartDateInfo: 'dateInfo',
  passengerName: 'person',
  seats: 'seats',
  wifiAccess: 'wifi',
  airplay: 'airplay',
  passengerCapabilities: 'capabilities',
  passengerServiceSSRs: 'serviceSSRs',
  passengerInformationSSRs: 'infoSSRs',
} as const satisfies Record<string, SemanticKind>;

export type SemanticTags = {
  [K in keyof typeof SEMANTIC_KINDS]?: KindTypes[(typeof SEMANTIC_KINDS)[K]];
};

export function semanticKind(key: string): SemanticKind | undefined {
  return (SEMANTIC_KINDS as Record<string, SemanticKind>)[key];
}
