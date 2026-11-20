import { redact } from '../../platform/log.ts';

/** A stored body is cut here, after redaction. */
export const BODY_MAX_CHARS = 8000;
/** A body larger than this is not parsed at all: a marker is stored instead. */
export const BODY_READ_MAX_BYTES = 64 * 1024;

/**
 * Personal data the logger's key list does not name: who holds a pass, where they are and what identifies them.
 * The logger already blanks emails, tokens, secrets, passwords, personalization and push tokens by key, and
 * emails, capability links and key shapes by value; this adds the rest of what a pass request carries.
 */
const PERSONAL_KEY =
  /(holder|member|first[-_]?name|last[-_]?name|full[-_]?name|display[-_]?name|phone|address|birth|dob|passport|photo|device[-_]?id|external[-_]?id)/i;
/** Pass field values are the holder's own: keep the shape, blank every leaf. */
const FIELD_BAG = /^(input|fields|values)$/i;
/** Query names that carry a capability or a code (the logger's value patterns know the same names inside a URL). */
const QUERY_SECRET = /^(?:t|token|code|key|state|sig|sign|link)$/i;
/** `/preview/<token>`, `/w/<token>` and kin: a capability in a link. */
const LINK_TOKEN = /(\/(?:preview|p|b|j|t|w)\/)[A-Za-z0-9_.~-]{12,}/g;

const BLANK = '[redacted]';

function blankLeaves(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value === null ? null : BLANK;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => blankLeaves(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankLeaves(v, depth + 1)]));
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(LINK_TOKEN, '$1[redacted]');
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      PERSONAL_KEY.test(k) ? BLANK : FIELD_BAG.test(k) ? blankLeaves(v) : scrub(v, depth + 1),
    ]),
  );
}

const cut = (text: string) =>
  text.length > BODY_MAX_CHARS ? `${text.slice(0, BODY_MAX_CHARS)}…[truncated]` : text;

/**
 * What is stored for one body: JSON with secrets, keys, tokens and personal data blanked, cut at 8,000
 * characters. Anything that is not JSON, or is too large to read, is a one-line marker: no text of it is kept.
 */
export function redactBody(text: string, contentType: string | null, bytes: number): string {
  if (!/json/i.test(contentType ?? '')) return `[${(contentType ?? 'no type').split(';')[0]}]`;
  if (bytes > BODY_READ_MAX_BYTES) return '[json, too large to keep]';
  try {
    return cut(JSON.stringify(redact(scrub(JSON.parse(text)))));
  } catch {
    return `[json, ${bytes} bytes, not parseable]`;
  }
}

/** The query string with every value that could be a secret or a person blanked, as it is stored. */
export function redactQuery(search: string): string | null {
  if (!search || search === '?') return null;
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    const blanked = redact({ [key]: value }) as Record<string, string>;
    out.append(
      key,
      PERSONAL_KEY.test(key) || QUERY_SECRET.test(key) ? BLANK : (blanked[key] ?? BLANK),
    );
  }
  return out.toString().slice(0, 500) || null;
}

/** The parameter names of a query string, without values: all a Live call keeps of it. */
export function queryKeys(search: string): string | null {
  const names = [...new Set(new URLSearchParams(search).keys())].map((k) => k.slice(0, 40));
  return names.length > 0 ? names.join('&').slice(0, 200) : null;
}
