import { redact, VALUE_PATTERNS } from '../../platform/log.ts';

/** A stored body is cut at this many bytes, after redaction. */
export const BODY_MAX_BYTES = 8192;
/** A body larger than this is not read at all: a marker is stored instead, and the call keeps its metadata. */
export const BODY_READ_MAX_BYTES = 16 * 1024;

/**
 * An allowlist: a scalar is stored only under an exact key known to hold no secret or personal data (ids, states,
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
/** The platform's own ids, times, counts and versions, matched exactly: a key that is not listed keeps no value. */
const SAFE_NAMED = [
  'passId',
  'templateId',
  'keyId',
  'orgId',
  'connectionId',
  'endpointId',
  'eventId',
  'bundleId',
  'scannerId',
  'viewId',
  'importId',
  'identityId',
  'batchId',
  'resourceId',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'revokedAt',
  'closedAt',
  'usedAt',
  'startedAt',
  'endedAt',
  'deliveredAt',
  'lastUsedAt',
  'usedCount',
  'passCount',
  'failedCount',
  'templateVersion',
  'apiVersion',
  'schemaVersion',
];
for (const key of SAFE_NAMED) SAFE_EXACT.add(key);

const isSafe = (key: string) => SAFE_EXACT.has(key);
/** The platform's own nested objects and lists; anything else holding an object is caller-shaped and blanked whole. */
const CONTAINERS = new Set([
  'items',
  'errors',
  'key',
  'keys',
  'previous',
  'org',
  'pass',
  'passes',
  'template',
  'templates',
  'sandbox',
  'limits',
  'flags',
  'counts',
  'links',
  'channels',
  'events',
  'calls',
  'results',
  'deliveries',
  'memberships',
  'capabilities',
]);
/** A problem+json answer (`status` and `title`): its `code`, `title` and `detail` are the platform's own words. */
const PROBLEM_KEYS = new Set(['code', 'title', 'detail']);

const BLANK = '[redacted]';

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Maps whose keys and values the caller chose: pass input, event data, connection config, import rows. Their whole
 * subtree is blanked, keys included. The allowlist above names the platform's own fields only.
 */
const OPAQUE = new Set(
  [
    'input',
    'data',
    'config',
    'fields',
    'rows',
    'row',
    'personalization',
    'metadata',
    'values',
    'options',
    'passJson',
    'patch',
    'claims',
    'mapping',
    'secrets',
    'headers',
    'attributes',
    'payload',
    'custom',
    'context',
    'params',
    'properties',
    'answers',
    'sample',
    'body',
    'extra',
    'tags',
    'scope',
    'overrides',
    'manifest',
  ].map((k) => k.toLowerCase()),
);

/**
 * A problem answer's `issues` are the platform's field contract (`path`, `code`, `message` per issue, never the
 * caller's values), so they stay readable. Anything else on an issue is blanked.
 */
const ISSUE_KEYS = new Set(['path', 'code', 'message']);
function issues(value: unknown): unknown {
  if (!Array.isArray(value)) return BLANK;
  return value.slice(0, 50).map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return BLANK;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .slice(0, 10)
        .map(([k, v]) => [
          k,
          ISSUE_KEYS.has(k) && typeof v === 'string' ? scrubString(v).slice(0, 300) : BLANK,
        ]),
    );
  });
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
    Object.entries(o)
      .slice(0, 100)
      .map(([k, v]) => [
        scrubString(k).slice(0, 64),
        problem && k === 'issues'
          ? issues(v)
          : OPAQUE.has(k.toLowerCase()) ||
              (v !== null && typeof v === 'object' && !isSafe(k) && !CONTAINERS.has(k))
            ? BLANK
            : walk(v, isSafe(k) || (problem && PROBLEM_KEYS.has(k)), depth + 1),
      ]),
  );
}

const MARK = '…[truncated]';
const encoder = new TextEncoder();

/** Text cut to `BODY_MAX_BYTES` bytes (never mid-character), with whether it was cut. */
function cut(text: string): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= BODY_MAX_BYTES) return { text, truncated: false };
  const head = new TextDecoder().decode(bytes.slice(0, BODY_MAX_BYTES)).replace(/\uFFFD$/, '');
  return { text: `${head}${MARK}`, truncated: true };
}

/**
 * What is stored for one body: JSON with every scalar outside the allowlist blanked (then the logger's own value
 * patterns over what stays), cut at 8 KB (`truncated`). Anything that is not JSON, or is too large to read, is a
 * one-line marker: no text of it is kept.
 */
export function redactBody(
  text: string,
  contentType: string | null,
  bytes: number,
): { text: string; truncated: boolean } {
  const whole = (marker: string) => ({ text: marker, truncated: false });
  if (!/json/i.test(contentType ?? ''))
    return whole(`[${(contentType ?? 'no type').split(';')[0]}]`);
  if (bytes > BODY_READ_MAX_BYTES) return { text: '[json, too large to keep]', truncated: true };
  try {
    return cut(JSON.stringify(redact(walk(JSON.parse(text), false, 0))));
  } catch {
    return whole(`[json, ${bytes} bytes, not parseable]`);
  }
}

/** The platform's own filter parameters: the only query values kept. Any other value is blanked. */
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
  'passId',
  'templateId',
  'keyId',
  'orgId',
  'connectionId',
  'endpointId',
  'eventId',
  'version',
  'method',
  'source',
  'portal',
  'after',
]);

/** The query string as stored: values kept only for the platform's own filters, every other value blanked. */
export function redactQuery(search: string): string | null {
  if (!search || search === '?') return null;
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search))
    out.append(
      scrubString(key).slice(0, 40),
      QUERY_SAFE.has(key) ? scrubString(value).slice(0, 100) : BLANK,
    );
  return out.toString().slice(0, 500) || null;
}
