import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';

export const LOG_API = '/api/v1/developer/logs';

/** The address's filters (`?status=4xx&key=<id>`), the path search among them. */
export const FILTER_KEYS = ['path', 'status', 'method', 'code', 'key', 'source'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type LogFilters = Partial<Record<FilterKey, string>>;

export interface Page {
  items: RequestLogEntry[];
  nextCursor: string | null;
  capped: 'hour' | 'total' | null;
}

const STATUS = /^(?:[1-5]xx|[1-5]\d\d)$/;
const CODE = /^[A-Z0-9_]{2,64}$/;
const SOURCES = new Set(['key', 'try', 'all']);

/**
 * The API's query for a view. Yours (the key's own calls) is the default source, since the portal's reads
 * would bury them. A value the API would refuse (a hand-typed link) is left out rather than failing the list.
 */
export function queryOf(f: LogFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  const path = f.path?.trim();
  if (path) q.set('path', path.slice(0, 200));
  if (f.status && STATUS.test(f.status)) q.set('status', f.status);
  if (f.method && (LOGS_BENCH_COPY.methods as readonly string[]).includes(f.method))
    q.set('method', f.method);
  if (f.code && CODE.test(f.code.toUpperCase())) q.set('code', f.code.toUpperCase());
  if (f.key) q.set('keyId', f.key);
  q.set('source', f.source && SOURCES.has(f.source) ? f.source : 'key');
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
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
