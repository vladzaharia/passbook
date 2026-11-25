import type { Json } from '../../../shared/contracts/common.ts';
import { offOrigin } from '../lib/egress.ts';
import { getPointer } from '../lib/pointer.ts';
import type { ListConfig } from './config.ts';
import type { PageState } from './cursor.ts';

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

/** The `rel="next"` target of a Link header, or null. */
export function nextFromLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!m) continue;
    const rels = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2] ?? '')?.[1]?.split(/\s+/) ?? [];
    if (rels.some((r) => r.toLowerCase() === 'next')) return m[1] ?? null;
  }
  return null;
}

/** The URL of the first or next request. A next link or Link header already carries its own query. */
export function pageUrl(base: URL, list: ListConfig, p: PageState | null, since?: string): URL {
  if (p?.u !== undefined) {
    const url = new URL(p.u, base);
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

/** A link to the next page, same origin only; the auth parameter never goes into a stored cursor. */
function linkState(raw: string | null, page: PageResult, base: URL, authParam?: string) {
  if (raw === null || raw === '') return null;
  if (!URL.canParse(raw, page.url.href)) return null;
  const url = new URL(raw, page.url);
  if (url.origin !== base.origin) throw offOrigin();
  if (authParam) url.searchParams.delete(authParam);
  return { u: `${url.pathname}${url.search}` } satisfies PageState;
}

function currentLink(page: PageResult, authParam?: string): string {
  const url = new URL(page.url);
  if (authParam) url.searchParams.delete(authParam);
  return `${url.pathname}${url.search}`;
}

/** Decides whether another page follows, and the state to request or to resume from. */
export function advance(
  list: ListConfig,
  p: PageState | null,
  page: PageResult,
  base: URL,
  authParam?: string,
): Advance {
  const pg = list.pagination;
  const empty = page.items.length === 0;
  const { k: _pages, ...stay } = p ?? {};
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
      const more = next !== null && next !== p?.c && flag && !empty;
      const state = next === null ? null : { c: next };
      return { more, next: state, rest: state ?? stayed };
    }
    case 'next-link':
    case 'link-header': {
      const raw =
        pg.style === 'next-link'
          ? asKey(getPointer(page.body, pg.nextPointer))
          : nextFromLinkHeader(page.headers.get('link'));
      const state = linkState(raw, page, base, authParam);
      const repeated = state !== null && state.u === currentLink(page, authParam);
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
