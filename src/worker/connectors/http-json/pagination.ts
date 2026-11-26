import type { Json } from '../../../shared/contracts/common.ts';
import { nextFromLinkHeader } from '../../../shared/rest/link-header.ts';
import { offOrigin } from '../lib/egress.ts';
import { getPointer } from '../lib/pointer.ts';
import type { ListConfig } from './config.ts';
import type { PageState } from './cursor.ts';

export { nextFromLinkHeader };

/** What one page tells us about the next. */
export interface Advance {
  more: boolean;
  /** Where the next request starts; null when there is none. */
  next: PageState | null;
  /** Where a feed resumes when the listing stops here. */
  rest: PageState | null;
}

export interface PageResult {
  url: URL;
  body: unknown;
  headers: Headers;
  items: readonly Json[];
}

const asKey = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null;

/** The URL of the first or next request. A next link or Link header already carries its own query. */
export function pageUrl(base: URL, list: ListConfig, p: PageState | null, since?: string): URL {
  if (p?.u !== undefined) {
    // Joined to the origin as text, never resolved as a reference: "//host/x" stays a path.
    if (!p.u.startsWith('/')) throw offOrigin();
    const url = new URL(`${base.origin}${p.u}`);
    if (url.origin !== base.origin) throw offOrigin();
    return url;
  }
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${list.path}`;
  for (const { name, value } of list.query) url.searchParams.set(name, value);
  const inc = list.incremental;
  if (inc && since !== undefined) url.searchParams.set(inc.param, since);
  const pg = list.pagination;
  if (pg.style === 'cursor' && p?.c !== undefined) url.searchParams.set(pg.param, p.c);
  if (pg.style === 'page') {
    url.searchParams.set(pg.param, String(p?.n ?? pg.start));
    if (pg.sizeParam && pg.size) url.searchParams.set(pg.sizeParam, String(pg.size));
  }
  if (pg.style === 'offset') {
    url.searchParams.set(pg.param, String(p?.n ?? 0));
    url.searchParams.set(pg.sizeParam, String(pg.size));
  }
  return url;
}

/** The credential, by parameter name or by value, so an echo under another name is dropped too. */
export interface Scrub {
  param?: string | undefined;
  secret?: string | undefined;
}

/** Path and query with the credential removed: what a cursor may store. */
function stored(url: URL, scrub: Scrub): string {
  const out = new URL(url);
  const name = scrub.param?.toLowerCase();
  for (const [key, value] of [...out.searchParams]) {
    if (key.toLowerCase() === name || (scrub.secret && value === scrub.secret)) {
      out.searchParams.delete(key);
    }
  }
  return `${out.pathname}${out.search}`;
}

/** A link to the next page, same origin only; the credential never goes into a stored cursor. */
function linkState(raw: string | null, page: PageResult, base: URL, scrub: Scrub) {
  if (raw === null || raw === '') return null;
  if (!URL.canParse(raw, page.url.href)) return null;
  const url = new URL(raw, page.url);
  if (url.origin !== base.origin) throw offOrigin();
  return { u: stored(url, scrub) } satisfies PageState;
}

/** Decides whether another page follows, and the state to request or to resume from. */
export function advance(
  list: ListConfig,
  p: PageState | null,
  page: PageResult,
  base: URL,
  scrub: Scrub = {},
): Advance {
  const pg = list.pagination;
  const empty = page.items.length === 0;
  const { k: _pages, s: _sig, ...stay } = p ?? {};
  const stayed = p === null ? null : stay;
  switch (pg.style) {
    case 'none':
      return { more: false, next: null, rest: null };
    case 'cursor': {
      const last = page.items.at(-1);
      const next =
        pg.from === 'last-id' && last !== undefined
          ? asKey(getPointer(last, list.idPointer))
          : pg.from === 'body'
            ? asKey(getPointer(page.body, pg.cursorPointer))
            : null;
      const flag = pg.hasMorePointer ? getPointer(page.body, pg.hasMorePointer) === true : true;
      // With an explicit has-more flag an empty page can still be followed by data (filtered listings).
      const more =
        next !== null && next !== p?.c && flag && (!empty || pg.hasMorePointer !== undefined);
      const state = next === null ? null : { c: next };
      return { more, next: state, rest: state ?? stayed };
    }
    case 'next-link':
    case 'link-header': {
      const raw =
        pg.style === 'next-link'
          ? asKey(getPointer(page.body, pg.nextPointer))
          : nextFromLinkHeader(page.headers.get('link'));
      const state = linkState(raw, page, base, scrub);
      const repeated = state !== null && state.u === stored(page.url, scrub);
      const more = state !== null && !repeated && !empty;
      return { more, next: state, rest: stayed };
    }
    case 'page': {
      const cur = p?.n ?? pg.start;
      const fromBody = pg.totalPagesPointer
        ? Number(getPointer(page.body, pg.totalPagesPointer))
        : Number.NaN;
      const fromHeader = pg.totalPagesHeader
        ? Number(page.headers.get(pg.totalPagesHeader))
        : Number.NaN;
      const total = [fromBody, fromHeader].find((n) => Number.isInteger(n) && n > 0);
      const more = !empty && (total === undefined || cur < pg.start + total - 1);
      return { more, next: { n: cur + 1 }, rest: { n: cur } };
    }
    case 'offset': {
      const n = (p?.n ?? 0) + page.items.length;
      const total = pg.totalPointer ? Number(getPointer(page.body, pg.totalPointer)) : Number.NaN;
      const more = !empty && !(Number.isFinite(total) && n >= total);
      return { more, next: { n }, rest: { n } };
    }
  }
}

/** A short digest of the page's whole ref list. */
async function pageSignature(refs: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(refs.join('\n'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${refs.length}:${hex}`;
}

/**
 * Whether this page repeats the one before (the API ignores our paging), and the signature to store with
 * the next state. The same records in the same order end the listing; one record can legitimately sit on two
 * pages in a row while the data moves, so a one-record page must repeat twice (marked "+" once) first.
 */
export async function repeatOf(
  refs: readonly string[],
  before: string | undefined,
  more: boolean,
): Promise<{ repeated: boolean; stored: string | undefined }> {
  const sig = refs.length > 0 ? await pageSignature(refs) : undefined;
  const same = sig !== undefined && before?.replace(/\+$/, '') === sig;
  const repeated = more && same && (refs.length > 1 || before?.endsWith('+') === true);
  return { repeated, stored: same && !repeated && sig !== undefined ? `${sig}+` : sig };
}
