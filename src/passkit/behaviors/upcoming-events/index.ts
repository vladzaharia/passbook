import type { BehaviorPlugin, Json, JsonSchemaObject, PassJson } from '../../types.ts';

export interface UpcomingEventsConfig {
  /** Input holding the array of events. */
  input: string;
  /** Lookup table of remote images by key: `{ URL, SHA256, size, scale? }`. */
  images?: string;
  /** Input holding the default IANA time zone; a row's own `timeZone` wins. */
  timeZoneInput?: string;
  /** Lowers the cap of 10. */
  max?: number;
  /** How long an event without an end counts as running. */
  fallbackMinutes?: number;
  /**
   * A season pass: while events are listed, Wallet expires the pass after the last one and
   * surfaces it around each one, `leadMinutes` early.
   */
  schedule?: { leadMinutes?: number };
}

const MAX_EVENTS = 10;
const MINUTE = 60_000;
const URL_KEYS = {
  website: 'contactVenueWebsite',
  directionsURL: 'directionsInformationURL',
  parkingURL: 'parkingInformationURL',
  transferURL: 'transferURL',
} as const;

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['input'],
  additionalProperties: false,
  properties: {
    input: { type: 'string', minLength: 1 },
    images: { type: 'string', minLength: 1 },
    timeZoneInput: { type: 'string', minLength: 1 },
    max: { type: 'integer', minimum: 1, maximum: MAX_EVENTS },
    fallbackMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    schedule: {
      type: 'object',
      additionalProperties: false,
      properties: { leadMinutes: { type: 'integer', minimum: 0, maximum: 1440 } },
    },
  },
};

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HEX64 = /^[0-9a-f]{64}$/i;
const httpsUrl = (value: Json | undefined) => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

type Row = Record<string, Json>;

function text(row: Row, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function date(row: Row, key: string, label: string): { iso: string; ms: number } | undefined {
  const iso = text(row, key);
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !ZONED.test(iso))
    throw new Error(
      `${label}: ${key} needs a date and time with a zone, like 2030-06-01T19:00:00-07:00.`,
    );
  return { iso, ms };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'event'
  );
}

function remoteImage(
  table: Record<string, Record<string, Json>> | undefined,
  key: string,
  label: string,
): Json {
  const record = table && Object.hasOwn(table, key) ? table[key] : undefined;
  if (typeof record !== 'object' || record === null)
    throw new Error(`${label}: no image named ${key}.`);
  const { URL, SHA256, size, scale } = record;
  if (!httpsUrl(URL)) throw new Error(`${label}: image ${key} needs an https URL.`);
  if (typeof SHA256 !== 'string' || !HEX64.test(SHA256))
    throw new Error(`${label}: image ${key} needs a 64-character SHA256.`);
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0)
    throw new Error(`${label}: image ${key} needs a size in bytes.`);
  return {
    URLs: [{ URL, SHA256, size, ...(scale !== undefined ? { scale } : {}) }],
  } as Json;
}

interface Listed {
  start: number | undefined;
  until: number | undefined;
}

/** One relevance interval per event and an expiry after the last one. Wallet caps an interval at a day. */
function schedule(pass: PassJson, events: readonly Listed[], leadMinutes: number): void {
  const windows = events.flatMap((e) => {
    if (e.start === undefined) return [];
    const from = e.start - leadMinutes * MINUTE;
    const until = Math.min(Math.max(e.until ?? e.start, e.start), from + DAY);
    return [{ startDate: iso(from), endDate: iso(until) }];
  });
  if (windows.length > 0) pass.relevantDates = windows;
  const first = events.find((e) => e.start !== undefined);
  if (first?.start !== undefined) pass.relevantDate = iso(first.start);
  const ends = events.flatMap((e) => (e.until === undefined ? [] : [e.until]));
  if (ends.length > 0) pass.expirationDate = iso(Math.max(...ends));
}

/**
 * Maps an array input of events to `upcomingPassInformation`: sorted by start, past events
 * dropped, the running one marked active. An event with no start shows as to be determined.
 * The list is a snapshot of build time: past events and the active mark only update when the
 * pass is next published.
 */
export const upcomingEvents: BehaviorPlugin<UpcomingEventsConfig> = {
  id: 'upcoming-events',
  version: 1,
  configSchema,
  apply(pass, input, config, ctx) {
    const supplied = input[config.input];
    if (supplied === undefined || supplied === null) {
      delete pass.upcomingPassInformation;
      return;
    }
    if (!Array.isArray(supplied)) throw new Error(`${config.input} is not a list.`);
    const now = ctx.now.getTime();
    const fallback = (config.fallbackMinutes ?? 180) * MINUTE;
    const images = config.images ? ctx.lookups[config.images] : undefined;
    const ids = new Set<string>();

    const events = supplied.flatMap((raw, i) => {
      const label = `Event ${i + 1}`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error(`${label} is not an event.`);
      const row = raw as Row;
      const name = text(row, 'name');
      if (!name) throw new Error(`${label} needs a name.`);
      const start = date(row, 'startsAt', label);
      const end = date(row, 'endsAt', label);
      if (start && end && end.ms < start.ms)
        throw new Error(`${label}: endsAt is before startsAt.`);
      const until = end?.ms ?? (start ? start.ms + fallback : undefined);
      if (until !== undefined && until < now) return [];

      const base =
        text(row, 'id') ??
        `${slug(name)}-${start ? start.iso.replace(/\D/g, '').slice(0, 12) : 'tbd'}`;
      let identifier = base;
      for (let n = 2; ids.has(identifier); n++) {
        if (text(row, 'id')) throw new Error(`${label}: id ${base} is used twice.`);
        identifier = `${base}-${n}`;
      }
      ids.add(identifier);

      const venueName = text(row, 'venueName');
      const region = text(row, 'venueRegion');
      const lat = row.venueLat;
      const lng = row.venueLng;
      const semantics: Row = { eventName: name };
      if (start) semantics.eventStartDate = start.iso;
      if (end) semantics.eventEndDate = end.iso;
      if (venueName) semantics.venueName = venueName;
      if (region) semantics.venueRegionName = region;
      if (typeof lat === 'number' && typeof lng === 'number')
        semantics.venueLocation = { latitude: lat, longitude: lng };

      const backFields: Row[] = [];
      const venue = [venueName, region].filter(Boolean).join(', ');
      if (venue) backFields.push({ key: 'venue', label: 'Venue', value: venue });
      const note = text(row, 'note');
      if (note) backFields.push({ key: 'note', label: 'Note', value: note });
      if (backFields.length === 0) backFields.push({ key: 'event', label: 'Event', value: name });

      const urls: Row = {};
      for (const [from, to] of Object.entries(URL_KEYS)) {
        const url = text(row, from);
        if (!url) continue;
        if (!httpsUrl(url)) throw new Error(`${label}: ${from} needs an https link.`);
        urls[to] = url;
      }
      const pictures: Row = {};
      for (const key of ['headerImage', 'venueMap'] as const) {
        const ref = text(row, key);
        if (ref) pictures[key] = remoteImage(images, ref, label);
      }

      const zone =
        text(row, 'timeZone') ??
        (config.timeZoneInput && typeof input[config.timeZoneInput] === 'string'
          ? (input[config.timeZoneInput] as string)
          : undefined);
      const entry: Row = {
        identifier,
        name,
        type: 'event',
        dateInformation: start
          ? { date: start.iso, ...(zone ? { timeZone: zone } : {}) }
          : { isUndetermined: true },
        isActive: start !== undefined && start.ms <= now && now <= (until ?? start.ms),
        semantics,
        backFields,
        ...(Object.keys(urls).length ? { URLs: urls } : {}),
        ...(Object.keys(pictures).length ? { images: pictures } : {}),
      };
      return [{ entry, at: start?.ms ?? Number.POSITIVE_INFINITY, start: start?.ms, until }];
    });

    const list = events
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at < b.at ? -1 : 1))
      .slice(0, config.max ?? MAX_EVENTS);
    if (list.length > 0)
      pass.upcomingPassInformation = list.map(
        (e) => e.entry,
      ) as unknown as PassJson['upcomingPassInformation'];
    else delete pass.upcomingPassInformation;
    if (config.schedule && list.length > 0) schedule(pass, list, config.schedule.leadMinutes ?? 0);
  },
};

export default upcomingEvents;
