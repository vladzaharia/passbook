import { redact, VALUE_PATTERNS } from '../../platform/log.ts';

/** A stored body is cut here, after redaction. */
export const BODY_MAX_CHARS = 8000;
/** A body larger than this is not read at all: a marker is stored instead, and the call keeps its metadata. */
export const BODY_READ_MAX_BYTES = 16 * 1024;

/**
 * An allowlist: a scalar is stored only under a field known to hold no secret or personal data (ids, states,
 * kinds, codes, versions, times, counts). Every other scalar, whatever its key (`name`, `pin`, `code` of a
 * pairing, `message`, `notes`, an input field), is `[redacted]`. Objects and arrays keep their shape, so a bad
 * field is still readable. This replaces a list of what to hide: a field nobody thought of is hidden by default.
 */
/** Cursors and OAuth-style `state` values are left out: a cursor may be a name, a `state` a secret. */
const SAFE_EXACT = new Set([
  'id',
  'ids',
  'status',
  'mode',
  'type',
  'kind',
  'version',
  'scopes',
  'active',
  'enabled',
  'limit',
  'count',
  'total',
  'hasMore',
  'requestId',
  'field',
  'path',
  'provider',
  'format',
  'sort',
  'order',
]);
/** `passId`, `templateId`, `createdAt`, `usedCount`: names that end like an id, a time or a count. */
const SAFE_SUFFIX = /^[a-z][A-Za-z]*(?:Id|Ids|At|Count|Version)$/;
/** An id of a person or a device is not safe: it names someone. */
const NOT_SAFE = /(external|device|holder|member|serial|barcode|email|user|push|token|secret)/i;

const isSafe = (key: string) =>
  (SAFE_EXACT.has(key) || SAFE_SUFFIX.test(key)) && !NOT_SAFE.test(key);
/** A problem+json answer (`status` and `title`): its `code`, `title` and `detail` are the platform's own words. */
const PROBLEM_KEYS = new Set(['code', 'title', 'detail']);

const BLANK = '[redacted]';

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function walk(value: unknown, safe: boolean, depth: number): unknown {
  if (value === null) return null;
  if (typeof value !== 'object')
    return safe && typeof value === 'string' ? scrubString(value) : safe ? value : BLANK;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, safe, depth + 1));
  const o = value as Record<string, unknown>;
  const problem = typeof o.status === 'number' && typeof o.title === 'string';
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      walk(v, isSafe(k) || (problem && PROBLEM_KEYS.has(k)), depth + 1),
    ]),
  );
}

const cut = (text: string) =>
  text.length > BODY_MAX_CHARS ? `${text.slice(0, BODY_MAX_CHARS)}…[truncated]` : text;

/**
 * What is stored for one body: JSON with every scalar outside the allowlist blanked (then the logger's own value
 * patterns over what stays), cut at 8,000 characters. Anything that is not JSON, or is too large to read, is a
 * one-line marker: no text of it is kept.
 */
export function redactBody(text: string, contentType: string | null, bytes: number): string {
  if (!/json/i.test(contentType ?? '')) return `[${(contentType ?? 'no type').split(';')[0]}]`;
  if (bytes > BODY_READ_MAX_BYTES) return '[json, too large to keep]';
  try {
    return cut(JSON.stringify(redact(walk(JSON.parse(text), false, 0))));
  } catch {
    return `[json, ${bytes} bytes, not parseable]`;
  }
}

/** Query parameters that hold no secret or person; any other value is blanked. */
const QUERY_SAFE = new Set([
  'limit',
  'status',
  'mode',
  'type',
  'kind',
  'sort',
  'order',
  'from',
  'to',
  'since',
  'until',
  'page',
  'provider',
]);

/** The query string as stored: values kept only for known-safe parameters and ids, every other value blanked. */
export function redactQuery(search: string): string | null {
  if (!search || search === '?') return null;
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    const keep = (QUERY_SAFE.has(key) || isSafe(key)) && !/^(?:token|key|sig|code|t)$/i.test(key);
    out.append(key.slice(0, 40), keep ? scrubString(value).slice(0, 100) : BLANK);
  }
  return out.toString().slice(0, 500) || null;
}
