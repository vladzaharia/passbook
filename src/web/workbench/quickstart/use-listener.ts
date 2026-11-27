import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { ApiError } from '../../lib/errors.ts';
import { isLimited } from '../../lib/poll-backoff.ts';
import { useSinglePoll } from './single-poll.ts';
import type { Fetcher } from './transport.tsx';

const API = '/api/v1/developer';
/** Stops after this long with no call: the page says how to check the key and offers to listen again. */
export const LISTEN_MS = 10 * 60_000;
/** After this long with no call the page names the usual causes, while it keeps listening. */
export const QUIET_MS = 45_000;

async function callsAfter(
  fetchFn: Fetcher,
  cursor: string | null,
  signal: AbortSignal,
): Promise<RequestLogEntry[]> {
  const q = `source=key&limit=10${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  const res = await fetchFn(`${API}/logs?${q}`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after'));
    throw new ApiError({
      status: 429,
      code: 'rate_limited',
      retryAfter: wait > 0 ? wait : undefined,
    });
  }
  if (!res.ok) return [];
  return ((await res.json()) as { items: RequestLogEntry[] }).items;
}

/**
 * Waits for a call made with a key of the sandbox from outside this page (the request log's `via` is null). Polls
 * the request log from the newest row it has seen, on the page's shared 2 s loop, for up to 10 minutes. `quiet` turns true after 45 s
 * with nothing heard. `heard` is every new call,
 * oldest first. No new transport: it is the same read the Logs page makes.
 */
export function useListener(active: boolean, startCursor: string | null, fetchFn: Fetcher = fetch) {
  const [heard, setHeard] = useState<RequestLogEntry[]>([]);
  const [over, setOver] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [round, setRound] = useState(0);
  /** Undefined until the first listen: the newest call the page already knew, so older calls never count. */
  const cursor = useRef<string | null | undefined>(undefined);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useRef(new AbortController());
  const until = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the Listen again restart
  useEffect(() => {
    if (!active) return;
    cursor.current ??= startCursor;
    setOver(false);
    setQuiet(false);
    quietTimer.current = setTimeout(() => setQuiet(true), QUIET_MS);
    stop.current = new AbortController();
    until.current = Date.now() + LISTEN_MS;
    return () => {
      stop.current.abort();
      clearTimeout(quietTimer.current);
    };
  }, [active, round, startCursor]);

  // The page's one shared loop calls this about every 2 s.
  useSinglePoll('listen', active && !over, async () => {
    if (Date.now() > until.current) return setOver(true);
    try {
      const rows = await callsAfter(fetchFn, cursor.current ?? null, stop.current.signal);
      const fresh = rows.slice().reverse();
      const newest = fresh.at(-1);
      if (newest) {
        cursor.current = newest.id;
        clearTimeout(quietTimer.current);
        setQuiet(false);
        setHeard((h) => [...h, ...fresh]);
      }
    } catch (error) {
      // A missed poll is a missed poll: the next one asks again from the same row. A 429 slows the loop.
      if (isLimited(error)) throw error;
    }
  });

  const again = useCallback(() => setRound((r) => r + 1), []);
  return { heard, over, quiet, again };
}
