import type { FieldDef } from './schema.ts';

export interface LatLng {
  lat: number;
  lng: number;
}

const PAIR = /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;

/**
 * Coordinates from "47.61, -122.33", an Apple Maps link (ll=, q=, daddr=, coordinate=) or a
 * Google Maps link (@lat,lng or q=). Undefined when nothing parses.
 */
export function parseLocation(text: string): LatLng | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  let candidate = raw;
  try {
    const url = new URL(raw);
    const p = url.searchParams;
    candidate =
      p.get('ll') ??
      p.get('coordinate') ??
      p.get('daddr') ??
      p.get('q') ??
      p.get('query') ??
      /@(-?[\d.]+,-?[\d.]+)/.exec(url.pathname)?.[1] ??
      url.pathname;
  } catch {
    // Not a URL: read the text itself as "lat, lng".
    candidate = raw;
  }
  const m = PAIR.exec(decodeURIComponent(candidate));
  if (!m) return undefined;
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

/** "Latitude must be from -90 to 90." for out-of-range parts; undefined when valid. */
export function locationError(value: LatLng | undefined, text: string): string | undefined {
  if (!text.trim()) return undefined;
  if (!value) return 'Enter "latitude, longitude" or paste a Maps link.';
  if (Math.abs(value.lat) > 90) return 'Latitude must be from -90 to 90.';
  if (Math.abs(value.lng) > 180) return 'Longitude must be from -180 to 180.';
  return undefined;
}

export const mapsUrl = (v: LatLng) => `https://maps.apple.com/?ll=${v.lat},${v.lng}`;

export interface LocationPair {
  /** "office" for officeLat / officeLng. */
  prefix: string;
  lat: FieldDef;
  lng: FieldDef;
  /** `<prefix>RelevantText`, when the template defines one. */
  text?: FieldDef | undefined;
}

const LAT = /^(.*?)(Lat|Latitude)$/;

/** Finds latitude and longitude fields that belong together (officeLat + officeLng). */
export function locationPairs(fields: readonly FieldDef[]): LocationPair[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: LocationPair[] = [];
  for (const f of fields) {
    const m = LAT.exec(f.key);
    if (!m || (f.type !== 'number' && f.type !== 'integer')) continue;
    const prefix = m[1] ?? '';
    const lng =
      byKey.get(`${prefix}Lng`) ?? byKey.get(`${prefix}Longitude`) ?? byKey.get(`${prefix}Lon`);
    if (!lng) continue;
    out.push({ prefix, lat: f, lng, text: byKey.get(`${prefix}RelevantText`) });
  }
  return out;
}

/** "Office latitude" -> "Office location". */
export const locationLabel = (pair: LocationPair) =>
  pair.lat.label.replace(/\s*latitude$/i, '').trim()
    ? `${pair.lat.label.replace(/\s*latitude$/i, '').trim()} location`
    : 'Location';
