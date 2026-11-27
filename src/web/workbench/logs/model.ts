import { IdSchema } from '../../../shared/contracts/common.ts';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';

/** The address's filters (`?status=4xx&key=<id>&tab=errors`), the path search among them. */
export const FILTER_KEYS = [
  'path',
  'status',
  'method',
  'code',
  'key',
  'pass',
  'version',
  'source',
] as const;
/** The view (`tab=errors`) is in the address too, but it is not a filter: it is not counted and Clear leaves it. */
export const VIEW_KEY = 'tab';
export type FilterKey = (typeof FILTER_KEYS)[number] | typeof VIEW_KEY;
export type LogFilters = Partial<Record<FilterKey, string>>;

const STATUS = /^(?:[1-5]xx|[1-5]\d\d)$/;
const CODE = /^[A-Z0-9_]{2,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set(['key', 'try']);

/**
 * The API's query for a view. A value the API would refuse (a hand-typed link) is left out rather than
 * failing the list. The default view is every call but the portal's own background reads; `try` is the
 * Workbench's and the docs' Run here, `key` is calls made with a key.
 */
export function queryOf(f: LogFilters): Record<string, string> {
  const q: Record<string, string> = {};
  const path = f.path?.trim();
  if (path) q.path = path.slice(0, 200);
  if (f.status && STATUS.test(f.status)) q.status = f.status;
  if (f.method && (LOGS_BENCH_COPY.methods as readonly string[]).includes(f.method))
    q.method = f.method;
  if (f.code && CODE.test(f.code.toUpperCase())) q.code = f.code.toUpperCase();
  if (f.key && IdSchema.safeParse(f.key).success) q.keyId = f.key;
  if (f.pass && IdSchema.safeParse(f.pass).success) q.passId = f.pass;
  if (f.version && VERSION.test(f.version)) q.version = f.version;
  if (f.source && SOURCES.has(f.source)) q.source = f.source;
  else q.portal = 'hide';
  return q;
}

/**
 * Old links carry the filter in the hash (`#code=X`, `#path=X`, from search and guides). The bench keeps
 * filters in the query, so such a hash moves there and the address stays shareable.
 */
export function migrateHash(): void {
  let hash = '';
  try {
    hash = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A malformed hash is no filter: the log opens as it is.
    return;
  }
  const m = /^(code|path)=(.*)$/.exec(hash);
  if (!m) return;
  const url = new URL(location.href);
  url.searchParams.set(m[1] as string, m[2] as string);
  url.hash = '';
  history.replaceState(history.state, '', url);
}

/** The path as the list and inspector title show it: without `/api/v1`, with its query. */
export const shownPath = (row: Pick<RequestLogEntry, 'path' | 'query'>): string =>
  (row.path.replace(/^\/api\/v1(?=\/|$)/, '') || '/') + (row.query ? `?${row.query}` : '');

/** The tail of an id, for a key the strip does not name. */
export const keyTail = (id: string): string => `…${id.slice(-6)}`;
