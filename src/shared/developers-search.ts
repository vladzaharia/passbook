/**
 * What the developer portal's search may do with the text a person types or pastes. Shared by the
 * browser (which decides what to look up) and the Worker (which re-checks every term it is sent),
 * so one definition says what a secret is and what is safe to log.
 */

/** A key or token: `pb_`, `pbp_`, `pbo_`, `pbtry_`, the older `wlt_`, or a webhook signing secret `whsec_`, then the secret part. */
const SECRET = /(?:^|[^A-Za-z0-9])(?:pbtry|pbp|pbo|pb|wlt|whsec)_[A-Za-z0-9_.~+/=-]{6,}/;
/** The prefix alone, even half typed: such text is never kept. */
const SECRET_PREFIX = /(?:^|[^A-Za-z0-9])(?:pbtry|pbp|pbo|pb|wlt|whsec)_/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAY = /[0-9a-f]{16}-[A-Za-z]{3}/i;
const METHODS = 'GET|POST|PUT|PATCH|DELETE';

export type Pasted =
  /** `tail` is the last four characters, for the "roll key" label; `signing` is a webhook signing secret. */
  | { kind: 'secret'; tail: string; signing: boolean }
  /** A UUID or a Cloudflare ray id: a request id or a resource id. */
  | { kind: 'id'; id: string }
  /** `POST /passes`, `/passes/{id}/void`, with or without `/api/v1`. */
  | { kind: 'route'; method: string | null; path: string }
  | { kind: 'text' };

export const isSecret = (text: string): boolean => SECRET.test(text);

/** What a search box holds: a secret, an id, a route or plain words. Checked in that order. */
export function classify(raw: string): Pasted {
  const text = raw.trim();
  const secret = SECRET.exec(text);
  if (secret)
    return { kind: 'secret', tail: secret[0].slice(-4), signing: /whsec_/.test(secret[0]) };
  if (new RegExp(`^(?:${UUID.source}|${RAY.source})$`, 'i').test(text))
    return { kind: 'id', id: text.toLowerCase() };
  const route = new RegExp(`^(?:(${METHODS})\\s+)?(/[^\\s?#]*)(?:[?#]\\S*)?$`, 'i').exec(text);
  if (route?.[2]) {
    const path = route[2].replace(/^\/api\/v1(?=\/|$)/, '').replace(/\/+$/, '') || '/';
    return { kind: 'route', method: route[1]?.toUpperCase() ?? null, path };
  }
  return { kind: 'text' };
}

/** A route pattern (`/passes/{id}`) against a path with real values in it. */
export function routeMatches(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((seg, i) => /^\{.+\}$/.test(seg) || seg === b[i]);
}

const TERM = /^[a-z0-9 ._/{}:-]+$/;

/** `12 main st`, `4 Oak Avenue`: a house number, up to three words, a street word. */
const STREET =
  /\b\d{1,6}\s+(?:[a-z.]+\s+){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|pl|place|way|hwy|highway)\b/;
/** A join, invite or capability link without its host: `/join/<token>`, `invite/<token>`, `/p/<token>`. */
const LINK = /(?:^|[\s/])(?:join|invite|invites|p|b|w)\/[a-z0-9_-]{6,}/;

/**
 * The words of a search that found nothing, or null when they are not safe to keep. Only short,
 * plain words survive: no key or token (even half typed), no id, address, link, phone or card
 * number (5 digits anywhere), street address, join or invite link, or long opaque run. A name
 * cannot be told from a word, so one that is typed can be kept. The Worker applies this again to
 * whatever the browser sends.
 */
export function missTerm(raw: string): string | null {
  const term = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (term.length < 2 || term.length > 60) return null;
  if (!TERM.test(term) || term.includes('//') || SECRET_PREFIX.test(term)) return null;
  if (UUID.test(term) || RAY.test(term)) return null;
  if ((term.match(/\d/g) ?? []).length >= 5 || STREET.test(term) || LINK.test(term)) return null;
  for (const word of term.split(' ')) {
    if (word.length > 32 || /[0-9a-f]{12,}/.test(word)) return null;
    if (word.length >= 16 && /\d/.test(word) && /[a-z]/.test(word)) return null;
    // A path segment this long is a token, not a name from the docs (`{braces}` are placeholders).
    if (
      word
        .replace(/\{[^}]*\}/g, '')
        .split('/')
        .some((seg) => seg.length >= 16)
    )
      return null;
  }
  return term;
}
