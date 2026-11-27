/**
 * The only headers a Test call's log keeps. This list is the boundary: nothing else is ever read, so no secret
 * (Authorization, Cookie, Set-Cookie, X-Api-Key, a signature) can reach a row.
 */
export const REQUEST_HEADERS = [
  'content-type',
  'content-length',
  'accept',
  'idempotency-key',
  'user-agent',
  'passbook-version',
  'if-none-match',
  'if-match',
] as const;
export const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'etag',
  'location',
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-request-id',
  'deprecation',
  'sunset',
] as const;

export interface LoggedHeaders {
  req: Record<string, string>;
  res: Record<string, string>;
}

const MAX = 256;
const PRINTABLE = /^[ -~]+$/;
/** Headers whose single value may hold a comma (a date, a media type, a URL, a tag list): read whole. */
const COMMA_IN_VALUE = new Set([
  'user-agent',
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'etag',
  'location',
  'retry-after',
  'deprecation',
  'sunset',
]);

/** One value, or null when it does not qualify: the first of a repeated header, printable ASCII, 256 characters at most. */
function keptValue(name: string, raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const head = (COMMA_IN_VALUE.has(name) ? raw : (raw.split(',')[0] ?? '')).trim();
  if (!PRINTABLE.test(head)) return null;
  if (head.length <= MAX) return head;
  return name === 'user-agent' ? `${head.slice(0, MAX - 1)}…` : null;
}

function pick(names: readonly string[], get: (name: string) => string | null | undefined) {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = keptValue(name, get(name));
    if (v !== null) out[name] = v;
  }
  return out;
}

/** The JSON stored for a call, or null when it carried none of the allowlisted headers. */
export function headersJson(
  request: (name: string) => string | null | undefined,
  response: Headers,
): string | null {
  const req = pick(REQUEST_HEADERS, request);
  const res = pick(RESPONSE_HEADERS, (n) => response.get(n));
  return Object.keys(req).length + Object.keys(res).length === 0
    ? null
    : JSON.stringify({ req, res });
}

/** A stored value read back; null for an older row or anything that is not the stored shape. */
export function headersOf(json: string | null): LoggedHeaders | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<LoggedHeaders>;
    const clean = (o: unknown) =>
      Object.fromEntries(
        Object.entries(o && typeof o === 'object' ? o : {}).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    return { req: clean(v.req), res: clean(v.res) };
  } catch {
    return null;
  }
}
