import type { PassJson } from '../types.ts';
import { COLOR_KEYS } from './constants.ts';
import { isObject, parseIsoDate } from './util.ts';

/** Subtrees that hold arbitrary issuer data; `_id` there is not a Pass Designer artifact. */
const OPAQUE_KEYS = new Set(['userInfo']);

/** Removes Pass Designer `_id` keys everywhere except opaque issuer data. */
export function stripDesignerIds<T>(value: T): T {
  if (Array.isArray(value)) for (const item of value) stripDesignerIds(item);
  else if (isObject(value)) {
    delete value._id;
    for (const [key, child] of Object.entries(value))
      if (!OPAQUE_KEYS.has(key)) stripDesignerIds(child);
  }
  return value;
}

/** `#rgb` / `#rrggbb` to `rgb(r, g, b)`; anything else is returned unchanged. */
export function hexToRgb(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!m?.[1]) return value;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const n = Number.parseInt(hex, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Pass Builder writes lowercase urls/url/sha256; Apple's documented casing is URLs/URL/SHA256. */
function recase(target: Record<string, unknown>, from: string, to: string): void {
  if (target[from] === undefined || target[to] !== undefined) return;
  target[to] = target[from];
  delete target[from];
}

function fixRemoteImages(entry: Record<string, unknown>): void {
  if (!isObject(entry.images)) return;
  for (const image of Object.values(entry.images)) {
    if (!isObject(image)) continue;
    recase(image, 'urls', 'URLs');
    if (!Array.isArray(image.URLs)) continue;
    for (const url of image.URLs) {
      if (!isObject(url)) continue;
      recase(url, 'url', 'URL');
      recase(url, 'sha256', 'SHA256');
    }
  }
}

/**
 * Prepares a pass for validation and signing: strips Pass Designer ids, converts hex colors,
 * and writes the compatibility duplicates Wallet versions disagree on. Returns a new object.
 */
export function normalizePass(input: PassJson): PassJson {
  const pass = stripDesignerIds(structuredClone(input)) as Record<string, unknown>;

  for (const key of COLOR_KEYS) if (pass[key] !== undefined) pass[key] = hexToRgb(pass[key]);
  if (isObject(pass.semantics) && Array.isArray(pass.semantics.seats))
    for (const seat of pass.semantics.seats)
      if (isObject(seat) && seat.seatSectionColor !== undefined)
        seat.seatSectionColor = hexToRgb(seat.seatSectionColor);

  // iOS 18 reads relevantDate inside relevantDates, iOS 26+ reads date; the root key serves iOS 17.
  if (Array.isArray(pass.relevantDates)) {
    for (const entry of pass.relevantDates) {
      if (!isObject(entry)) continue;
      if (entry.date !== undefined && entry.relevantDate === undefined)
        entry.relevantDate = entry.date;
      else if (entry.relevantDate !== undefined && entry.date === undefined)
        entry.date = entry.relevantDate;
    }
    const first = pass.relevantDates.find(isObject);
    const supportsDate = !('coupon' in pass || 'storeCard' in pass);
    const start = first ? (first.date ?? first.startDate) : undefined;
    if (pass.relevantDate === undefined && supportsDate && parseIsoDate(start) !== undefined)
      pass.relevantDate = start;
  }

  // Wallet reads maxDistance per location, not at the root.
  if (typeof pass.maxDistance === 'number' && pass.maxDistance > 0 && Array.isArray(pass.locations))
    for (const location of pass.locations)
      if (isObject(location) && location.maxDistance === undefined)
        location.maxDistance = pass.maxDistance;

  for (const barcode of [
    ...(Array.isArray(pass.barcodes) ? pass.barcodes : []),
    ...(pass.barcode ? [pass.barcode] : []),
  ])
    if (isObject(barcode) && barcode.messageEncoding === undefined)
      barcode.messageEncoding = 'iso-8859-1';

  if (Array.isArray(pass.upcomingPassInformation))
    for (const entry of pass.upcomingPassInformation) if (isObject(entry)) fixRemoteImages(entry);

  return pass as PassJson;
}
