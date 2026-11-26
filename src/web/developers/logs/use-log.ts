import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { LOG_API, type LogFilters, type Page, queryOf } from './model.ts';

/** How often the log asks for newer calls while the tab is in view. Reading the log is never logged itself. */
export const POLL_MS = 4000;
/** Ten quiet minutes and it stops asking; Resume starts it again. */
export const IDLE_MS = 10 * 60_000;
/** A new row keeps its accent this long. */
const FRESH_MS = 4000;
/** A path typed in the search asks after this pause. */
const TYPE_MS = 250;

export type LogPhase = 'loading' | 'ready' | 'failed' | 'out' | 'no-sandbox';

async function readPage(path: string): Promise<{ status: number; page: Page | null }> {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    return { status: res.status, page: res.ok ? ((await res.json()) as Page) : null };
  } catch (error) {
    // Offline: the list says it did not load, and the page's handler hears why.
    reportError(error);
    return { status: 0, page: null };
  }
}

/** `value`, after it has held still for `ms`; the first value is immediate. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The request log under the address's filters: the first page, more by cursor, and a listener that asks
 * for newer calls every few seconds while the tab is in view and stops after ten quiet minutes. A refetch
 * keeps the old rows (`busy` dims them) until the new ones land.
 */
export function useLog(filters: LogFilters) {
  const query = queryOf(filters);
  const settled = useSettled(query, TYPE_MS);
  const [phase, setPhase] = useState<LogPhase>('loading');
  const [items, setItems] = useState<RequestLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [capped, setCapped] = useState<Page['capped']>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [retries, setRetries] = useState(0);
  const run = useRef(0);
  const wake = useRef<() => void>(() => undefined);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const newest = useRef<string | null>(null);
  const quietSince = useRef(Date.now());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const latest = useRef({ settled, cursor });
  latest.current = { settled, cursor };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retries` is the Retry button's nudge.
  useEffect(() => {
    const mine = ++run.current;
    setBusy(true);
    void readPage(`${LOG_API}?${settled}`).then(({ status, page }) => {
      if (mine !== run.current) return;
      setBusy(false);
      if (status === 401) return setPhase('out');
      if (status === 404) return setPhase('no-sandbox');
      if (!page) return setPhase('failed');
      newest.current = page.items[0]?.id ?? null;
      setItems(page.items);
      setCursor(page.nextCursor);
      setCapped(page.capped);
      setFresh(new Set());
      setPhase('ready');
      // Changing the view is activity: a paused listener starts again.
      quietSince.current = Date.now();
      if (pausedRef.current) wake.current();
    });
  }, [settled, retries]);

  const loadMore = useCallback(async () => {
    const { settled: q, cursor: at } = latest.current;
    if (!at) return;
    const mine = run.current;
    setMore(true);
    const { page } = await readPage(`${LOG_API}?${q}&cursor=${encodeURIComponent(at)}`);
    if (mine !== run.current) return;
    setMore(false);
    if (!page) return;
    setItems((all) => {
      const have = new Set(all.map((r) => r.id));
      return [...all, ...page.items.filter((r) => !have.has(r.id))];
    });
    setCursor(page.nextCursor);
  }, []);

  const ready = phase === 'ready';
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearFresh: ReturnType<typeof setTimeout>[] = [];
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    async function tick() {
      if (stopped || document.visibilityState !== 'visible') return;
      if (Date.now() - quietSince.current > IDLE_MS) return setPaused(true);
      const mine = run.current;
      const q = latest.current.settled;
      const after = newest.current ? `&after=${encodeURIComponent(newest.current)}` : '';
      const { page } = await readPage(`${LOG_API}?${q}${after}`);
      if (!stopped && mine === run.current && page) {
        const have = new Set(itemsRef.current.map((r) => r.id));
        const added = page.items.filter((r) => !have.has(r.id));
        newest.current = page.items[0]?.id ?? newest.current;
        if (added.length > 0) {
          quietSince.current = Date.now();
          setItems((all) => [...added, ...all.filter((r) => !added.some((a) => a.id === r.id))]);
          setFresh(new Set(added.map((r) => r.id)));
          setAnnounce(LOGS_BENCH_COPY.fresh(added.length));
          clearFresh.push(setTimeout(() => setFresh(new Set()), FRESH_MS));
        }
      }
      schedule();
    }
    wake.current = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      if (Date.now() - quietSince.current > IDLE_MS) return setPaused(true);
      setPaused(false);
      void tick();
    };
    const onVisible = () => wake.current();
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const t of clearFresh) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready]);
  const resume = useCallback(() => {
    quietSince.current = Date.now();
    setPaused(false);
    wake.current();
  }, []);

  return {
    phase,
    items,
    capped,
    busy,
    more,
    hasMore: cursor !== null,
    loadMore,
    fresh,
    paused,
    resume,
    announce,
    retry: () => {
      setPhase('loading');
      setRetries((n) => n + 1);
    },
  };
}
