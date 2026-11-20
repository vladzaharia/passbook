/**
 * What the developer portal's search may do with the text a person types or pastes. Shared by the
 * browser (which decides what to look up) and the Worker (which re-checks every term it is sent),
 * so one definition says what a secret is and what is safe to log.
 */

/** A key or token: `pb_`, `pbp_`, `pbo_`, `pbtry_` or the older `wlt_`, then the secret part. */
const SECRET = /(?:^|[^A-Za-z0-9])(?:pbtry|pbp|pbo|pb|wlt)_[A-Za-z0-9_.~+/=-]{6,}/;
/** The prefix alone, even half typed: such text is never kept. */
const SECRET_PREFIX = /(?:^|[^A-Za-z0-9])(?:pbtry|pbp|pbo|pb|wlt)_/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAY = /[0-9a-f]{16}-[A-Za-z]{3}/i;
const METHODS = 'GET|POST|PUT|PATCH|DELETE';

export type Pasted =
  /** `tail` is the last four characters, for the "roll key" label. */
  | { kind: 'secret'; tail: string }
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
  if (secret) return { kind: 'secret', tail: secret[0].slice(-4) };
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

/**
 * The words of a search that found nothing, or null when they are not safe to keep. Only short,
 * plain words survive: no key or token (even half typed), no id, address, link, number string or
 * long opaque run. The Worker applies this again to whatever the browser sends.
 */
export function missTerm(raw: string): string | null {
  const term = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (term.length < 2 || term.length > 60) return null;
  if (!TERM.test(term) || term.includes('//') || SECRET_PREFIX.test(term)) return null;
  if (UUID.test(term) || RAY.test(term)) return null;
  for (const word of term.split(' ')) {
    if (word.length > 32 || /\d{5,}/.test(word) || /[0-9a-f]{12,}/.test(word)) return null;
    if (word.length >= 16 && /\d/.test(word) && /[a-z]/.test(word)) return null;
  }
  return term;
}
