import type { PassJson } from '../types.ts';
import {
  EVENT_TYPES,
  PASSENGER_CAPABILITIES,
  SECURITY_PROGRAMS,
  SERVICE_SSRS,
  type SemanticKind,
  semanticKind,
} from './semantic-types.ts';
import {
  isFiniteNumber,
  isObject,
  isRgb,
  parseIsoDate,
  type Report,
  type ValidationContext,
} from './util.ts';

type Check = (value: unknown, path: string, error: Report, warn: Report) => void;

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function checkKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
  warn: Report,
): void {
  for (const key of Object.keys(value))
    if (!known.includes(key) && key !== '_id')
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
}

function checkDateInfo(value: unknown, path: string, error: Report, warn: Report): void {
  if (!isObject(value)) {
    error('SEMANTICS_TYPE', 'Expected an object.', path);
    return;
  }
  checkKeys(
    value,
    ['date', 'ignoreTimeComponents', 'timeZone', 'unannounced', 'undetermined'],
    path,
    warn,
  );
  if (value.date !== undefined && parseIsoDate(value.date) === undefined)
    error('SEMANTICS_TYPE', 'date must be ISO 8601.', `${path}.date`);
  for (const key of ['ignoreTimeComponents', 'unannounced', 'undetermined'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      error('SEMANTICS_TYPE', `${key} must be a boolean.`, `${path}.${key}`);
  if (value.timeZone !== undefined && !(isString(value.timeZone) && validTimeZone(value.timeZone)))
    error('SEMANTICS_TYPE', 'timeZone must be an IANA zone.', `${path}.timeZone`);
}

function checkPerson(value: unknown, path: string, error: Report, warn: Report): void {
  if (!isObject(value)) {
    error('SEMANTICS_TYPE', 'Expected an object.', path);
    return;
  }
  checkKeys(
    value,
    [
      'familyName',
      'givenName',
      'middleName',
      'namePrefix',
      'nameSuffix',
      'nickname',
      'phoneticRepresentation',
    ],
    path,
    warn,
  );
  for (const [key, v] of Object.entries(value)) {
    if (key === 'phoneticRepresentation') checkPerson(v, `${path}.${key}`, error, warn);
    else if (key !== '_id' && !isString(v))
      error('SEMANTICS_TYPE', `${key} must be a string.`, `${path}.${key}`);
  }
}

const SEAT_KEYS = [
  'seatDescription',
  'seatIdentifier',
  'seatNumber',
  'seatRow',
  'seatSection',
  'seatType',
  'seatAisle',
  'seatLevel',
  'seatSectionColor',
];

function enumArray(values: readonly string[], label: string, open = false): Check {
  return (value, path, error, warn) => {
    if (!isStringArray(value)) {
      error('SEMANTICS_TYPE', 'Expected an array of strings.', path);
      return;
    }
    value.forEach((v, i) => {
      if (!values.includes(v))
        (open ? warn : error)('SEMANTICS_ENUM', `Unknown ${label} ${v}.`, `${path}.${i}`);
    });
  };
}

const KIND_CHECKS: Record<SemanticKind, Check> = {
  ls: (v, p, error) => isString(v) || error('SEMANTICS_TYPE', 'Expected a string.', p),
  date: (v, p, error) =>
    parseIsoDate(v) !== undefined || error('SEMANTICS_TYPE', 'Expected an ISO 8601 date.', p),
  bool: (v, p, error) =>
    typeof v === 'boolean' || error('SEMANTICS_TYPE', 'Expected a boolean.', p),
  number: (v, p, error) => isFiniteNumber(v) || error('SEMANTICS_TYPE', 'Expected a number.', p),
  tz: (v, p, error) =>
    (isString(v) && validTimeZone(v)) || error('SEMANTICS_TYPE', 'Expected an IANA time zone.', p),
  lsArray: (v, p, error) =>
    isStringArray(v) || error('SEMANTICS_TYPE', 'Expected an array of strings.', p),
  stringArray: (v, p, error) =>
    isStringArray(v) || error('SEMANTICS_TYPE', 'Expected an array of strings.', p),
  dateInfo: checkDateInfo,
  location: (v, p, error, warn) => {
    if (!isObject(v)) {
      error('SEMANTICS_TYPE', 'Expected an object.', p);
      return;
    }
    checkKeys(v, ['latitude', 'longitude'], p, warn);
    if (!isFiniteNumber(v.latitude) || !isFiniteNumber(v.longitude))
      error('SEMANTICS_TYPE', 'latitude and longitude are required numbers.', p);
  },
  person: checkPerson,
  seats: (v, p, error, warn) => {
    if (!Array.isArray(v)) {
      error('SEMANTICS_TYPE', 'Expected an array.', p);
      return;
    }
    v.forEach((seat, i) => {
      const path = `${p}.${i}`;
      if (!isObject(seat)) {
        error('SEMANTICS_TYPE', 'Expected an object.', path);
        return;
      }
      checkKeys(seat, SEAT_KEYS, path, warn);
      for (const key of SEAT_KEYS) {
        const x = seat[key];
        if (x === undefined) continue;
        if (key === 'seatSectionColor' ? !isRgb(x) : !isString(x))
          error(
            'SEMANTICS_TYPE',
            `${key} must be ${key === 'seatSectionColor' ? 'rgb(r, g, b)' : 'a string'}.`,
            `${path}.${key}`,
          );
      }
    });
  },
  currency: (v, p, error, warn) => {
    if (!isObject(v)) {
      error('SEMANTICS_TYPE', 'Expected an object.', p);
      return;
    }
    checkKeys(v, ['amount', 'currencyCode'], p, warn);
    if (!isString(v.amount) || !isString(v.currencyCode) || !/^[A-Z]{3}$/.test(v.currencyCode))
      error('SEMANTICS_TYPE', 'amount (string) and currencyCode (ISO 4217) are required.', p);
  },
  wifi: (v, p, error, warn) => {
    if (!Array.isArray(v)) {
      error('SEMANTICS_TYPE', 'Expected an array.', p);
      return;
    }
    v.forEach((net, i) => {
      const path = `${p}.${i}`;
      if (!isObject(net)) {
        error('SEMANTICS_TYPE', 'Expected an object.', path);
        return;
      }
      checkKeys(net, ['ssid', 'password', 'captiveToken', 'captiveTokenAuthURL'], path, warn);
      if (!isString(net.ssid) || !isString(net.password))
        error('SEMANTICS_TYPE', 'ssid and password are required strings.', path);
    });
  },
  airplay: (v, p, error) => {
    if (!Array.isArray(v) || !v.every((e) => isObject(e) && isString(e.airPlayDeviceGroupToken)))
      error('SEMANTICS_TYPE', 'Expected [{ airPlayDeviceGroupToken }].', p);
  },
  eventType: (v, p, error) =>
    (isString(v) && (EVENT_TYPES as readonly string[]).includes(v)) ||
    error('SEMANTICS_ENUM', 'Unknown event type.', p),
  securityPrograms: enumArray(SECURITY_PROGRAMS, 'security program'),
  capabilities: enumArray(PASSENGER_CAPABILITIES, 'capability'),
  serviceSSRs: enumArray(SERVICE_SSRS, 'service code', true),
  infoSSRs: enumArray(['INFT'], 'information code', true),
};

/** Types every tag in a `semantics` dictionary. Unknown tags warn (forward compatibility). */
export function validateSemantics(ctx: ValidationContext, semantics: unknown, path: string): void {
  if (semantics === undefined) return;
  if (!isObject(semantics)) {
    ctx.error('SEMANTICS_TYPE', 'semantics must be an object.', path);
    return;
  }
  for (const [key, value] of Object.entries(semantics)) {
    if (key === '_id') continue;
    const kind = semanticKind(key);
    if (!kind) {
      ctx.warn('UNKNOWN_SEMANTIC_TAG', `Unknown semantic tag ${key}.`, `${path}.${key}`);
      continue;
    }
    KIND_CHECKS[kind](value, `${path}.${key}`, ctx.error, ctx.warn);
    if (key === 'balance' && !ctx.styles.has('storeCard'))
      ctx.warn('SEMANTICS_STYLE', 'balance applies to store cards only.', `${path}.${key}`);
  }
}

const PET_REQUIRED = ['eventName', 'venueName', 'venueRegionName', 'venueRoom'];
const SBP_REQUIRED = [
  'airlineCode',
  'flightNumber',
  'departureAirportCode',
  'departureCityName',
  'departureLocationTimeZone',
  'destinationAirportCode',
  'destinationCityName',
  'destinationLocationTimeZone',
  'originalArrivalDate',
  'originalBoardingDate',
  'originalDepartureDate',
  'passengerName',
];
const TZ_ALIASES: Record<string, string> = {
  departureLocationTimeZone: 'departureAirportTimeZone',
  destinationLocationTimeZone: 'destinationAirportTimeZone',
};

const STYLE_KEYS = [
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
];

/** Wallet reads semantics from the root and from any field; the root wins on conflict. */
export function collectSemantics(pass: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const style of STYLE_KEYS) {
    const dict = pass[style];
    if (!isObject(dict)) continue;
    for (const fields of Object.values(dict))
      if (Array.isArray(fields))
        for (const field of fields)
          if (isObject(field) && isObject(field.semantics)) Object.assign(out, field.semantics);
  }
  return isObject(pass.semantics) ? Object.assign(out, pass.semantics) : out;
}

/** False when Wallet would fall back from the poster event ticket to the legacy layout. */
export function hasPosterEventSemantics(pass: PassJson): boolean {
  const semantics = collectSemantics(pass as unknown as Record<string, unknown>);
  return PET_REQUIRED.every((key) => semantics[key] !== undefined && semantics[key] !== '');
}

/** Layout-driving tags. Wallet falls back to the legacy layout when they are missing, so these warn. */
export function validateRequiredSemantics(ctx: ValidationContext): void {
  const semantics = collectSemantics(ctx.pass as unknown as Record<string, unknown>);
  const missing = (keys: string[]) =>
    keys.filter((key) => {
      const alias = TZ_ALIASES[key];
      return (
        semantics[key] === undefined && (alias === undefined || semantics[alias] === undefined)
      );
    });
  const report = (label: string, keys: string[]) => {
    const absent = missing(keys);
    if (absent.length)
      ctx.warn('SEMANTICS_REQUIRED', `${label} layout needs ${absent.join(', ')}.`, 'semantics');
  };
  if (ctx.styles.has('PET')) {
    report('Poster event ticket', PET_REQUIRED);
    if (semantics.eventType === 'PKEventTypeSports')
      report('Sports poster event ticket', ['homeTeamAbbreviation', 'awayTeamAbbreviation']);
    if (semantics.eventType === 'PKEventTypeLivePerformance')
      report('Live performance poster event ticket', ['performerNames']);
  }
  if (ctx.styles.has('SBP')) report('Semantic boarding pass', SBP_REQUIRED);
}
