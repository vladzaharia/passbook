/** The one set of rules for an org's From display name. Server write, send time and the form use it. */

export const FROM_NAME_MAX = 64;
/** Always protected, whatever the platform sender name is set to. */
export const PLATFORM_NAME = 'PassBook';

const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u200b-\u200f\u2028-\u202f\u2060\u2066-\u2069\ufeff]/gu;
const QUOTES_BRACKETS = /["'`‘’“”<>\\]/gu;

export type FromNameResult = { ok: true; value: string } | { ok: false; error: string };

/** Letters and digits only, case and width folded: "P a s s-Book" matches "passbook". */
function fold(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Cleans a From name or refuses it. Strips control characters (CR, LF included), bidi and
 * zero-width marks, quotes and angle brackets; refuses an empty result, one over 64 characters,
 * anything that looks like an email address, and a name that contains a platform name, unless it
 * is exactly "<something> via <platform name>".
 */
export function checkFromName(raw: unknown, platformName: string = PLATFORM_NAME): FromNameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name.' };
  const value = raw
    .normalize('NFKC')
    .replace(UNSAFE, ' ')
    .replace(QUOTES_BRACKETS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return { ok: false, error: 'Enter a name.' };
  if (value.length > FROM_NAME_MAX)
    return { ok: false, error: `Use ${FROM_NAME_MAX} characters or fewer.` };
  if (value.includes('@') || /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(value))
    return { ok: false, error: 'Use a name, not an email address or domain.' };
  for (const platform of new Set([PLATFORM_NAME, platformName])) {
    const needle = fold(platform);
    if (!needle || !fold(value).includes(needle)) continue;
    const via = value.match(/^(.+?) via (.+)$/i);
    const viaOk = via?.[1] && via[2] && fold(via[2]) === needle && !fold(via[1]).includes(needle);
    if (!viaOk) return { ok: false, error: `Do not use the name ${platform}.` };
  }
  return { ok: true, value };
}
