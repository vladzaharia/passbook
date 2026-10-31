import { MAX_RELEVANCE_ENTRIES, MAX_RELEVANT_RANGE_MS } from './constants.ts';
import {
  hasStyle,
  isFiniteNumber,
  isObject,
  isUint16,
  parseIsoDate,
  type ValidationContext,
} from './util.ts';

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function unknownKeys(
  ctx: ValidationContext,
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value))
    if (!known.includes(key) && key !== '_id')
      ctx.warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
}

export function validateLocations(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  if (pass.maxDistance !== undefined) {
    if (!isFiniteNumber(pass.maxDistance) || pass.maxDistance <= 0)
      error('MAX_DISTANCE', 'maxDistance must be a number greater than 0.', 'maxDistance');
  }
  if (pass.locations === undefined) return;
  if (!Array.isArray(pass.locations)) {
    error('LOCATIONS', 'locations must be an array.', 'locations');
    return;
  }
  if (pass.locations.length > MAX_RELEVANCE_ENTRIES)
    error('LOCATIONS', 'At most 10 locations.', 'locations');
  let missingPerLocation = false;
  pass.locations.forEach((loc: unknown, i) => {
    const path = `locations.${i}`;
    if (!isObject(loc)) {
      error('LOCATION', 'Location must be an object.', path);
      return;
    }
    unknownKeys(
      ctx,
      loc,
      ['latitude', 'longitude', 'altitude', 'relevantText', 'maxDistance'],
      path,
    );
    if (!isFiniteNumber(loc.latitude) || loc.latitude < -90 || loc.latitude > 90)
      error('LOCATION', 'latitude must be a number between -90 and 90.', `${path}.latitude`);
    if (!isFiniteNumber(loc.longitude) || loc.longitude < -180 || loc.longitude > 180)
      error('LOCATION', 'longitude must be a number between -180 and 180.', `${path}.longitude`);
    if (loc.altitude !== undefined && !isFiniteNumber(loc.altitude))
      error('LOCATION', 'altitude must be a number.', `${path}.altitude`);
    if (loc.relevantText !== undefined) {
      if (typeof loc.relevantText !== 'string')
        error('LOCATION', 'relevantText must be a string.', `${path}.relevantText`);
      else if (
        typeof pass.organizationName === 'string' &&
        pass.organizationName !== '' &&
        loc.relevantText.toLowerCase().includes(pass.organizationName.toLowerCase())
      )
        warn(
          'RELEVANT_TEXT',
          'relevantText repeats the organization name.',
          `${path}.relevantText`,
        );
    }
    if (loc.maxDistance !== undefined) {
      // Wallet rejects the whole pass for a value <= 0.
      if (!isFiniteNumber(loc.maxDistance) || loc.maxDistance <= 0)
        error(
          'MAX_DISTANCE',
          'maxDistance must be a number greater than 0.',
          `${path}.maxDistance`,
        );
    } else missingPerLocation = true;
  });
  if (isFiniteNumber(pass.maxDistance) && pass.maxDistance > 0 && missingPerLocation)
    warn(
      'ROOT_MAX_DISTANCE',
      'Wallet reads maxDistance per location, not at the root.',
      'maxDistance',
    );
}

export function validateBeacons(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  if (pass.beacons === undefined) return;
  if (!Array.isArray(pass.beacons)) {
    error('BEACONS', 'beacons must be an array.', 'beacons');
    return;
  }
  if (pass.beacons.length > MAX_RELEVANCE_ENTRIES)
    error('BEACONS', 'At most 10 beacons.', 'beacons');
  pass.beacons.forEach((beacon: unknown, i) => {
    const path = `beacons.${i}`;
    if (!isObject(beacon)) {
      error('BEACON', 'Beacon must be an object.', path);
      return;
    }
    unknownKeys(ctx, beacon, ['proximityUUID', 'major', 'minor', 'relevantText', 'name'], path);
    if (typeof beacon.proximityUUID !== 'string' || !UUID.test(beacon.proximityUUID))
      error('BEACON', 'proximityUUID must be a UUID.', `${path}.proximityUUID`);
    for (const key of ['major', 'minor'])
      if (beacon[key] !== undefined && !isUint16(beacon[key]))
        error('BEACON', `${key} must be an integer from 0 to 65535.`, `${path}.${key}`);
    if (beacon.minor !== undefined && beacon.major === undefined)
      warn('BEACON', 'minor without major is ignored.', `${path}.minor`);
    if (beacon.relevantText !== undefined && typeof beacon.relevantText !== 'string')
      error('BEACON', 'relevantText must be a string.', `${path}.relevantText`);
  });
}

export function validateRelevantDates(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  const dates = pass.relevantDates;
  if (dates !== undefined) {
    if (!Array.isArray(dates))
      error('RELEVANT_DATES', 'relevantDates must be an array.', 'relevantDates');
    else
      dates.forEach((entry: unknown, i) => {
        const path = `relevantDates.${i}`;
        if (!isObject(entry)) {
          error('RELEVANT_DATES', 'Entry must be an object.', path);
          return;
        }
        unknownKeys(ctx, entry, ['startDate', 'endDate', 'date', 'relevantDate'], path);
        for (const key of ['startDate', 'endDate', 'date', 'relevantDate'])
          if (entry[key] !== undefined && parseIsoDate(entry[key]) === undefined)
            error('DATE', `${key} must be ISO 8601 with hours and minutes.`, `${path}.${key}`);
        const range = entry.startDate !== undefined || entry.endDate !== undefined;
        const single = entry.date !== undefined || entry.relevantDate !== undefined;
        if (range === single) {
          error('RELEVANT_DATES', 'Use startDate and endDate, or a single date.', path);
          return;
        }
        if (range) {
          const start = parseIsoDate(entry.startDate);
          const end = parseIsoDate(entry.endDate);
          if (entry.startDate === undefined || entry.endDate === undefined) {
            error('RELEVANT_DATES', 'startDate and endDate go together.', path);
            return;
          }
          if (start !== undefined && end !== undefined) {
            if (end < start) error('RELEVANT_DATES', 'endDate is before startDate.', path);
            // Wallet logs "Dropping relevancy interval" and keeps the pass.
            else if (end - start > MAX_RELEVANT_RANGE_MS)
              warn(
                'RELEVANT_DATE_RANGE',
                'Wallet ignores relevance intervals longer than 24 hours. Use a single date.',
                path,
              );
          }
        } else if ((entry.date === undefined) !== (entry.relevantDate === undefined)) {
          warn(
            'RELEVANT_DATE_COMPAT',
            'Set both date (iOS 26+) and relevantDate (iOS 18) on a single moment.',
            path,
          );
        }
      });
  }
  const hasDates = pass.relevantDate !== undefined || dates !== undefined;
  if (!hasDates) return;
  if (
    hasStyle(ctx, 'coupon', 'storeCard') &&
    !hasStyle(ctx, 'generic', 'eventTicket', 'boardingPass')
  )
    warn('RELEVANT_DATE_STYLE', 'Coupons and store cards ignore relevant dates.', 'relevantDates');
  const hasLocations = Array.isArray(pass.locations) && pass.locations.length > 0;
  if (hasLocations && hasStyle(ctx, 'generic', 'posterGeneric') && !hasStyle(ctx, 'PET', 'SBP'))
    warn(
      'RELEVANT_DATE_LOCATION',
      'On generic passes a date and a location must both match, so the pass is relevant only inside the window.',
      pass.relevantDates !== undefined ? 'relevantDates' : 'relevantDate',
    );
}
