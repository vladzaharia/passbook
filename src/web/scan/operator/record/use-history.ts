import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryFilter, HistoryItem } from '../../../../shared/contracts/scan-history.ts';
import type { ScanApi } from '../../api/scan-api.ts';

interface Loaded {
  /** The person and filter these lines are of: another one's lines are never shown. */
  key: string;
  items: HistoryItem[];
  next: string | null;
  status: 'ready' | 'failed';
}

/**
 * The person's history, a page at a time. Lines belong to their person and filter: change either
 * and the old ones are gone at once, never shown under another name. `refresh` re-reads in place
 * (a scan or an action just happened) without clearing what is shown.
 */
export function useHistory(api: ScanApi, passId: string, refresh: unknown) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [paging, setPaging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = `${passId}:${filter}`;
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    // The refresh and the retry counter only trigger the read.
    void refresh;
    void attempt;
    const run = new AbortController();
    ac.current?.abort();
    ac.current = run;
    Promise.resolve()
      .then(() => api.history(passId, { filter }, { signal: run.signal }))
      .then(
        (page) => {
          if (!run.signal.aborted)
            setLoaded({ key, items: page.items, next: page.nextCursor, status: 'ready' });
        },
        () => {
          if (!run.signal.aborted)
            setLoaded((was) =>
              was?.key === key && was.status === 'ready'
                ? was
                : { key, items: [], next: null, status: 'failed' },
            );
        },
      );
    return () => run.abort();
  }, [api, passId, filter, key, refresh, attempt]);

  const current = loaded?.key === key ? loaded : null;
  const next = current?.next ?? null;
  const more = useCallback(async () => {
    if (!next) return;
    setPaging(true);
    try {
      const page = await api.history(passId, { filter, cursor: next });
      setLoaded((was) => {
        if (was?.key !== key) return was;
        const seen = new Set(was.items.map((i) => i.id));
        return {
          ...was,
          items: [...was.items, ...page.items.filter((i) => !seen.has(i.id))],
          next: page.nextCursor,
        };
      });
    } catch {
      setLoaded((was) => (was?.key === key ? { ...was, status: 'failed' } : was));
    } finally {
      setPaging(false);
    }
  }, [api, passId, filter, key, next]);

  return {
    filter,
    setFilter,
    items: current?.items ?? [],
    loading: current === null,
    failed: current?.status === 'failed',
    hasMore: next !== null,
    paging,
    more,
    retry: () => {
      setLoaded(null);
      setAttempt((n) => n + 1);
    },
  };
}
