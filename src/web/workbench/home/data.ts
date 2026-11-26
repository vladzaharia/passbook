import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { RequestLogPageSchema } from '../../../shared/contracts/developer.ts';
import { PassListSchema } from '../../../shared/contracts/passes.ts';
import { EventFeedPageSchema } from '../../../shared/contracts/webhooks.ts';
import { WorkbenchSummarySchema } from '../../../shared/contracts/workbench-read.ts';
import type { WorkbenchApi } from '../host/api.ts';

/** Home reads only through the host's token client: Test is the token's own mode. */
const P = {
  summary: '/api/v1/workbench/summary',
  logs: '/api/v1/request-logs',
  events: '/api/v1/events',
  passes: '/api/v1/passes',
} as const;

export const CALLS_LIMIT = 8;
export const EVENTS_LIMIT = 5;
export const PASSES_LIMIT = 5;
export const CALLS_POLL_MS = 5_000;
export const EVENTS_POLL_MS = 5_000;
const SUMMARY_POLL_MS = 15_000;
const PASSES_POLL_MS = 15_000;
/** The feed pages oldest first: the newest rows are at its end, so a first read walks to it. */
const FEED_PAGE = 200;
const FEED_PAGES_MAX = 8;

export type Summary = z.infer<typeof WorkbenchSummarySchema>;
export type CallRow = z.infer<typeof RequestLogPageSchema>['items'][number];
export type EventRow = z.infer<typeof EventFeedPageSchema>['items'][number];
export type PassRow = z.infer<typeof PassListSchema>['items'][number];

export function useHomeSummary(api: WorkbenchApi) {
  return useQuery({
    queryKey: ['workbench', 'home', 'summary', api.orgId] as const,
    queryFn: ({ signal }) =>
      api.get(P.summary, WorkbenchSummarySchema, { query: { orgId: api.orgId }, signal }),
    refetchInterval: SUMMARY_POLL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useRecentCalls(api: WorkbenchApi) {
  return useQuery({
    queryKey: ['workbench', 'home', 'calls', api.orgId] as const,
    queryFn: ({ signal }) =>
      api.get(P.logs, RequestLogPageSchema, {
        query: { orgId: api.orgId, limit: CALLS_LIMIT },
        signal,
      }),
    refetchInterval: CALLS_POLL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useRecentPasses(api: WorkbenchApi) {
  return useQuery({
    queryKey: ['workbench', 'home', 'passes', api.orgId] as const,
    queryFn: ({ signal }) =>
      api.get(P.passes, PassListSchema, {
        query: { orgId: api.orgId, limit: PASSES_LIMIT },
        signal,
      }),
    refetchInterval: PASSES_POLL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

const PassLinkSchema = z.object({ publicUrl: z.string() });

/** The Test preview link of one pass: the page the phone card shows as a QR. */
export function usePassLink(api: WorkbenchApi, passId: string | undefined) {
  return useQuery({
    queryKey: ['workbench', 'home', 'pass-link', api.orgId, passId] as const,
    queryFn: ({ signal }) => api.get(`${P.passes}/${passId}`, PassLinkSchema, { signal }),
    enabled: passId !== undefined,
    staleTime: 5 * 60_000,
  });
}

export interface RecentEvents {
  /** Newest first, at most `EVENTS_LIMIT`. */
  items: EventRow[];
  /** Still reading the feed for the first time. */
  loading: boolean;
  error: unknown;
  retry: () => void;
}

const newestFirst = (rows: readonly EventRow[]) => rows.slice(-EVENTS_LIMIT).reverse();

/**
 * Recent events: the feed is a cursor over rows oldest first, so the first read walks to its end and
 * keeps the last few; then it asks only for what is after the cursor, every few seconds while the
 * tab is visible, and a hidden tab asks once when it returns.
 */
export function useRecentEvents(api: WorkbenchApi): RecentEvents {
  const [items, setItems] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const cursor = useRef<string | undefined>(undefined);

  useEffect(() => {
    void attempt;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let caughtUp = false;
    cursor.current = undefined;
    setLoading(true);
    setError(null);

    const read = async (limit: number) =>
      api.get(P.events, EventFeedPageSchema, {
        query: { orgId: api.orgId, limit, after: cursor.current },
        signal: ctl.signal,
      });

    const first = async () => {
      let tail: EventRow[] = [];
      for (let i = 0; i < FEED_PAGES_MAX; i++) {
        const page = await read(FEED_PAGE);
        cursor.current = page.nextCursor;
        tail = [...tail, ...page.items].slice(-EVENTS_LIMIT);
        if (!page.hasMore) break;
      }
      setItems(newestFirst(tail));
      setLoading(false);
    };

    const poll = async () => {
      if (ctl.signal.aborted) return;
      if (document.visibilityState === 'visible') {
        try {
          const page = await read(50);
          cursor.current = page.nextCursor;
          if (page.items.length > 0)
            setItems((prev) => newestFirst([...prev.slice().reverse(), ...page.items]));
        } catch (e) {
          // A failed refresh keeps what is shown; the next tick asks again.
          if (ctl.signal.aborted) return;
          void e;
        }
      }
      timer = setTimeout(poll, EVENTS_POLL_MS);
    };

    const back = () => {
      if (document.visibilityState === 'visible' && caughtUp) {
        clearTimeout(timer);
        void poll();
      }
    };

    first().then(
      () => {
        caughtUp = true;
        timer = setTimeout(poll, EVENTS_POLL_MS);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e);
        setLoading(false);
      },
    );
    document.addEventListener('visibilitychange', back);
    return () => {
      ctl.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [api, attempt]);

  return { items, loading, error, retry };
}

/**
 * Ids that arrived after the first read: the lists wash them for 1.6 s. The first read never
 * washes, so a page that opens full does not flash.
 */
export function useFresh(ids: readonly string[] | undefined, ready: boolean): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ids?.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
  useEffect(() => {
    if (!ready || !ids) return;
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const known = seen.current;
    const added = ids.filter((id) => !known.has(id));
    if (added.length === 0) return;
    for (const id of added) known.add(id);
    setFresh((prev) => new Set([...prev, ...added]));
    // Not cleared on the next change: each wash ends on its own clock.
    setTimeout(
      () =>
        setFresh((prev) => {
          const next = new Set(prev);
          for (const id of added) next.delete(id);
          return next;
        }),
      1_700,
    );
  }, [key, ready]);
  return fresh;
}
