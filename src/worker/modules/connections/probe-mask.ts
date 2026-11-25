const MASK = '***';
const MAX_HEADER_CHARS = 2000;
const SHOWN_HEADERS = new Set([
  'content-type',
  'link',
  'etag',
  'last-modified',
  'retry-after',
  'x-total-count',
  'x-total',
  'x-total-pages',
  'x-total-page-count',
  'x-wp-total',
  'x-wp-totalpages',
  'x-page',
  'x-per-page',
]);

const shown = (name: string, extra: readonly string[]): boolean =>
  SHOWN_HEADERS.has(name) ||
  name.startsWith('x-next-') ||
  name.includes('ratelimit') ||
  extra.some((e) => e.toLowerCase() === name);

function b64(text: string): string | null {
  try {
    return btoa(text);
  } catch {
    return null;
  }
}

/** Every way a credential can come back in an answer: raw, URL-encoded, as base64 and as `user:pass` base64. */
function variantsOf(secrets: unknown): string[] {
  const values =
    typeof secrets === 'object' && secrets !== null
      ? Object.values(secrets).filter((v): v is string => typeof v === 'string' && v !== '')
      : [];
  const { username, password } = (secrets ?? {}) as Record<string, unknown>;
  if (typeof username === 'string' && typeof password === 'string')
    values.push(`${username}:${password}`);
  const all = new Set<string>();
  for (const v of values) {
    all.add(v);
    all.add(encodeURIComponent(v));
    const encoded = b64(v);
    if (encoded) all.add(encoded);
  }
  // Longest first, so a value that contains another is masked whole.
  return [...all].sort((a, b) => b.length - a.length);
}

export interface Masker {
  text(value: string): string;
  /** A copy of a parsed JSON document with the credentials gone, from strings and from keys. */
  json(value: unknown): unknown;
  /** A request URL with the credential parameter and any credential value masked. */
  url(raw: string): string;
  /** The shown response headers, lower-cased and masked. */
  headers(headers: Headers, extra?: readonly string[]): Record<string, string>;
}

/**
 * Masks the request's own credentials in everything the probe returns. The probe echoes upstream content to the
 * admin who configured it (§6.4), so no field may carry a credential the upstream reflects.
 */
export function masker(secrets: unknown, queryParam?: string): Masker {
  const variants = variantsOf(secrets);
  const text = (value: string): string => {
    let out = value;
    for (const v of variants) if (out.includes(v)) out = out.split(v).join(MASK);
    return out;
  };
  const json = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') return variants.includes(String(value)) ? MASK : value;
    if (Array.isArray(value)) return value.map(json);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const key in value) {
      if (Object.hasOwn(value, key)) out[text(key)] = json((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  return {
    text,
    json,
    url(raw) {
      if (!URL.canParse(raw)) return text(raw);
      const url = new URL(raw);
      const name = queryParam?.toLowerCase();
      for (const [key] of [...url.searchParams]) {
        if (key.toLowerCase() === name) url.searchParams.set(key, MASK);
      }
      return text(url.toString());
    },
    headers(headers, extra = []) {
      const out: Record<string, string> = {};
      for (const [name, value] of headers) {
        if (shown(name.toLowerCase(), extra))
          out[name.toLowerCase()] = text(value).slice(0, MAX_HEADER_CHARS);
      }
      return out;
    },
  };
}
