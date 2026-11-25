const MASK = '***';
const MAX_HEADER_CHARS = 2000;
/** A value shorter than this is masked only when it is a whole string: as a substring it would garble the body and give itself away. */
const MIN_SUBSTRING = 8;
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

const shown = (name: string): boolean =>
  SHOWN_HEADERS.has(name) || name.startsWith('x-next-') || name.includes('ratelimit');

function b64(text: string): string | null {
  try {
    return btoa(text);
  } catch {
    return null;
  }
}
const b64url = (text: string): string | null =>
  b64(text)?.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') ?? null;
const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Variant {
  text: string;
  /** Percent-encodings and hex come back in either case. */
  anyCase: boolean;
}

/** Every way a credential can come back in an answer. */
function variantsOf(secrets: unknown): { long: Variant[]; whole: Set<string> } {
  const values =
    typeof secrets === 'object' && secrets !== null
      ? Object.values(secrets).filter((v): v is string => typeof v === 'string' && v !== '')
      : [];
  const { username, password } = (secrets ?? {}) as Record<string, unknown>;
  const pair = typeof username === 'string' && typeof password === 'string';
  if (pair) values.push(`${username}:${password}`);
  const whole = new Set<string>();
  const long = new Map<string, Variant>();
  const add = (text: string | null, anyCase = false) => {
    if (text) long.set(text, { text, anyCase: anyCase || long.get(text)?.anyCase === true });
  };
  for (const v of values) {
    if (v.length < MIN_SUBSTRING) {
      whole.add(v);
      continue;
    }
    const json = JSON.stringify(v).slice(1, -1);
    add(v);
    add(encodeURIComponent(v), true);
    add(new URLSearchParams({ v }).toString().slice(2), true);
    add(json);
    add(json.replaceAll('/', '\\/'));
    add(b64(v));
    add(b64url(v));
    add(b64(`Bearer ${v}`));
    add(b64url(`Bearer ${v}`));
    add(hex(v), true);
  }
  return { long: [...long.values()].sort((a, b) => b.text.length - a.text.length), whole };
}

export interface Masker {
  /** A string with the credentials gone. */
  text(value: string): string;
  /** A request URL with the credential parameter and any credential value masked. */
  url(raw: string): string;
  /**
   * The shown response headers, lower-cased and masked. A name in `numeric` (a configured page-count header)
   * is shown too, but only as a number.
   */
  headers(headers: Headers, numeric?: readonly string[]): Record<string, string>;
}

/**
 * Masks the request's own credentials in everything the probe returns. The probe echoes upstream content to
 * callers who may probe (§6.4), so no field may carry a credential the upstream reflects, in the forms an
 * upstream re-serializes it.
 */
export function masker(secrets: unknown, queryParam?: string): Masker {
  const { long, whole } = variantsOf(secrets);
  const patterns = long.map((v) =>
    v.anyCase
      ? { re: new RegExp(escapeRe(v.text), 'gi'), text: v.text }
      : { re: null, text: v.text },
  );
  const text = (value: string): string => {
    if (whole.has(value)) return MASK;
    let out = value;
    for (const p of patterns) {
      if (p.re) out = out.replace(p.re, MASK);
      else if (out.includes(p.text)) out = out.split(p.text).join(MASK);
    }
    return out;
  };
  return {
    text,
    url(raw) {
      if (!URL.canParse(raw)) return text(raw);
      const url = new URL(raw);
      const name = queryParam?.toLowerCase();
      for (const [key] of [...url.searchParams]) {
        if (key.toLowerCase() === name) url.searchParams.set(key, MASK);
      }
      return text(url.toString());
    },
    headers(headers, numeric = []) {
      const out: Record<string, string> = {};
      const extra = numeric.map((n) => n.toLowerCase());
      for (const [raw, value] of headers) {
        const name = raw.toLowerCase();
        if (shown(name) || (extra.includes(name) && /^\d{1,9}$/.test(value.trim())))
          out[text(name)] = text(value).slice(0, MAX_HEADER_CHARS);
      }
      return out;
    },
  };
}
