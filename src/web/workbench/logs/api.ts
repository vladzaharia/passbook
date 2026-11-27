import { z } from 'zod';
import {
  type RequestLogDetail,
  RequestLogDetailSchema,
  type RequestLogEntry,
  RequestLogPageSchema,
} from '../../../shared/contracts/developer.ts';
import type { ToolApi } from '../../lib/tool-api.tsx';
import type { BenchGet } from '../bench/trace-events.ts';
import { type LogFilters, queryOf } from './model.ts';

/** The org's Test calls, read with the Workbench token (design §3.3). */
const LOG_PATH = '/api/v1/request-logs';

/** Where a stream has more: the status stream (`''` when the view is one stream) to its cursor. */
export type Cursor = Readonly<Record<string, string>>;

export interface Page {
  items: RequestLogEntry[];
  cursor: Cursor | null;
  capped: 'hour' | 'total' | null;
}

/** The Errors tab reads 4xx and 5xx as two streams, since the API takes one status class at a time. */
const streamsOf = (f: LogFilters): string[] => {
  if (f.tab !== 'errors') return [f.status ?? ''];
  return f.status && /^[45]/.test(f.status) ? [f.status] : ['4xx', '5xx'];
};

const newest = (a: RequestLogEntry, b: RequestLogEntry) => b.at - a.at || (a.id < b.id ? 1 : -1);

/**
 * One read of the log under the filters: the first page, the next by `cursor`, or the newer calls
 * after `after`. Merged streams stay newest first.
 */
export async function readLog(
  api: ToolApi,
  filters: LogFilters,
  opts: { cursor?: Cursor | null; after?: string | null; signal?: AbortSignal } = {},
): Promise<Page> {
  const wanted = streamsOf(filters).filter((k) => !opts.cursor || opts.cursor[k]);
  const pages = await Promise.all(
    wanted.map((k) =>
      api.get(LOG_PATH, RequestLogPageSchema, {
        query: {
          ...queryOf({ ...filters, status: k || undefined }),
          cursor: opts.cursor?.[k],
          after: opts.after ?? undefined,
        },
        signal: opts.signal,
      }),
    ),
  );
  const next: Record<string, string> = {};
  wanted.forEach((k, i) => {
    const c = pages[i]?.nextCursor;
    if (c) next[k] = c;
  });
  return {
    items: pages.flatMap((p) => p.items).sort(newest),
    cursor: Object.keys(next).length > 0 ? next : null,
    capped: pages.find((p) => p.capped)?.capped ?? null,
  };
}

/** One call by its log id or request id, with bodies where the org records them. */
export function readOne(api: ToolApi, id: string, signal?: AbortSignal): Promise<RequestLogDetail> {
  return api.get(`${LOG_PATH}/${encodeURIComponent(id)}`, RequestLogDetailSchema, { signal });
}

const KeysSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      prefix: z.string(),
      mode: z.string(),
      revokedAt: z.number().nullable(),
    }),
  ),
});
export interface LogKey {
  id: string;
  name: string;
  prefix: string;
}

/** The org's Test keys, for the Key filter's names. */
export async function readKeys(
  api: ToolApi,
  orgId: string | undefined,
  signal?: AbortSignal,
): Promise<LogKey[]> {
  const { items } = await api.get('/api/v1/api-keys', KeysSchema, {
    query: { orgId, limit: 100 },
    signal,
  });
  return items
    .filter((k) => k.mode === 'test' && k.revokedAt === null)
    .map(({ id, name, prefix }) => ({ id, name, prefix }));
}

/** The caller's reads for the Trace: events a request caused. */
export const traceGet =
  (api: ToolApi): BenchGet =>
  <T>(path: string) =>
    api.get(`/api/v1${path}`, z.unknown()) as Promise<T>;
