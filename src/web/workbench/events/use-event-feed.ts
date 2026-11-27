import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { WebhookEventSchema } from '@/shared/contracts/webhooks.ts';
import { pacer } from '../../lib/poll-backoff.ts';
import type { EventsApi, FeedFilter } from './api.ts';

export type FeedEvent = z.infer<typeof WebhookEventSchema>;

export const FEED_POLL_MS = 4000;
const FRESH_MS = 4000;
/** The ledger reads oldest first: read to its end, 200 at a time, up to this many pages. */
const MAX_PAGES = 25;
const KEEP = 500;

export interface EventFeed {
  /** Newest first. */
  events: FeedEvent[];
  /** The first read has answered. */
  ready: boolean;
  /** The first read failed; Retry reads again. */
  failed: boolean;
  /** The tab is hidden: polling waits. */
  paused: boolean;
  /** Events that arrived since the last poll: they rise in, then glow. */
  fresh: ReadonlySet<string>;
  reload: () => void;
  resume: () => void;
}

const keyOf = (f: FeedFilter) => `${f.type ?? ''}|${f.request ?? ''}|${f.pass ?? ''}`;

/**
 * The event list that stays current. The ledger is a cursor feed, oldest first: it is read to its
 * end once, then asked for what is newer every 4 s while the tab is shown. A new filter starts over.
 */
export function useEventFeed(api: EventsApi, filter: FeedFilter): EventFeed {
  const key = keyOf(filter);
  const [state, setState] = useState<{ key: string; events: FeedEvent[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mine = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the filter's contents.
  const read = useCallback(
    async (first: boolean) => {
      const run = mine.current;
      let got: FeedEvent[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await api.feed(cursor.current, filter);
        if (run !== mine.current) return;
        cursor.current = page.nextCursor;
        got = got.concat(page.items);
        if (!page.hasMore) break;
      }
      if (!first && got.length === 0) return;
      const arrived = got.map((e) => e.id).reverse();
      setState((prev) => {
        const same = prev?.key === key && !first ? prev.events : [];
        const have = new Set(same.map((e) => e.id));
        const added = got.filter((e) => !have.has(e.id)).reverse();
        return { key, events: [...added, ...same].slice(0, KEEP) };
      });
      setFailed(false);
      if (!first && arrived.length > 0) {
        setFresh(new Set(arrived));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
      }
    },
    [api, key],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry button's nudge.
  useEffect(() => {
    mine.current += 1;
    cursor.current = undefined;
    setFailed(false);
    setFresh(new Set());
    read(true).catch(() => setFailed(true));
    const pace = pacer('events-feed', FEED_POLL_MS);
    let poll: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const again = (error?: unknown) => {
      if (!stopped) poll = setTimeout(() => void loop(), pace.after(error));
    };
    const loop = async () => {
      if (document.hidden || cursor.current === undefined) return again();
      try {
        await read(false);
        again();
      } catch (error) {
        again(error);
      }
    };
    again();
    const tick = () => {
      setPaused(document.hidden);
      if (!document.hidden && cursor.current !== undefined) read(false).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', tick);
    return () => {
      mine.current += 1;
      stopped = true;
      clearTimeout(poll);
      pace.stop();
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [read, attempt]);

  const ready = state?.key === key;
  return {
    events: ready ? state.events : [],
    ready,
    failed: failed && !ready,
    paused,
    fresh,
    reload: () => setAttempt((n) => n + 1),
    resume: () => {
      setPaused(false);
      read(false).catch(() => undefined);
    },
  };
}
