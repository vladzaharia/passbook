import type { BehaviorPlugin, Json, JsonSchemaObject, PassJson } from '../../types.ts';

export interface UpcomingEventsConfig {
  /** Input holding the array of events. */
  input: string;
  /** Lookup table of remote images by key: `{ URL, SHA256, size, scale? }`. */
  images?: string;
  /** Lowers the cap of 10. */
  max?: number;
  /** How long an event without an end counts as running. */
  fallbackMinutes?: number;
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
    max: { type: 'integer', minimum: 1, maximum: MAX_EVENTS },
    fallbackMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
  },
};

type Row = Record<string, Json>;

function text(row: Row, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function date(row: Row, key: string, label: string): { iso: string; ms: number } | undefined {
  const iso = text(row, key);
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !/T\d{2}:\d{2}/.test(iso))
    throw new Error(`${label}: ${key} needs a date and time.`);
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
  const record = table?.[key];
  if (!record) throw new Error(`${label}: no image named ${key}.`);
  const { URL, SHA256, size, scale } = record;
  return {
    URLs: [{ URL, SHA256, size, ...(scale !== undefined ? { scale } : {}) }],
  } as Json;
}

/**
 * Maps an array input of events to `upcomingPassInformation`: sorted by start, past events
 * dropped, the running one marked active. An event with no start shows as to be determined.
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
        if (url) urls[to] = url;
      }
      const pictures: Row = {};
      for (const key of ['headerImage', 'venueMap'] as const) {
        const ref = text(row, key);
        if (ref) pictures[key] = remoteImage(images, ref, label);
      }

      const zone = text(row, 'timeZone');
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
      return [{ entry, at: start?.ms ?? Number.POSITIVE_INFINITY }];
    });

    const list = events
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at < b.at ? -1 : 1))
      .slice(0, config.max ?? MAX_EVENTS)
      .map((e) => e.entry);
    if (list.length > 0)
      pass.upcomingPassInformation = list as unknown as PassJson['upcomingPassInformation'];
    else delete pass.upcomingPassInformation;
  },
};

export default upcomingEvents;
