import type { Json } from './types.ts';

/**
 * A try token must never reach the page. The API does not echo one, but a proxy or a mistake
 * could: anything that looks like one is cut before a response is drawn or a message shown.
 */
const TRY_TOKEN = /pbtry_[A-Za-z0-9_.~+/=-]+/g;
export const masked = (text: string): string => text.replace(TRY_TOKEN, 'pbtry_…');

/** The same cut for parsed values: an escape such as `\\u005f` only becomes a token after JSON.parse. */
export function maskedJson(v: Json): Json {
  if (typeof v === 'string') return masked(v);
  if (Array.isArray(v)) return v.map(maskedJson);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [masked(k), maskedJson(x)]));
  return v;
}
