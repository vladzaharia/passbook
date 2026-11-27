import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { Fetcher } from './transport.tsx';

const API = '/api/v1/developer';
const POLL_MS = 2000;
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
  if (!res.ok) return [];
  return ((await res.json()) as { items: RequestLogEntry[] }).items;
}

/**
 * Waits for a call made with a key of the sandbox from outside this page (the request log's `via` is null). Polls
 * the request log from the newest row it has seen, every 2 s, for up to 10 minutes. `quiet` turns true after 45 s
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the Listen again restart
  useEffect(() => {
    if (!active) return;
    cursor.current ??= startCursor;
    setOver(false);
    setQuiet(false);
    const quietTimer = setTimeout(() => setQuiet(true), QUIET_MS);
    const stop = new AbortController();
    const until = Date.now() + LISTEN_MS;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() > until) {
        setOver(true);
        clearInterval(timer);
        return;
      }
      try {
        const rows = await callsAfter(fetchFn, cursor.current ?? null, stop.signal);
        const fresh = rows.slice().reverse();
        const newest = fresh.at(-1);
        if (newest) {
          cursor.current = newest.id;
          clearTimeout(quietTimer);
          setQuiet(false);
          setHeard((h) => [...h, ...fresh]);
        }
      } catch {
        // A missed poll is a missed poll: the next one asks again from the same row.
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stop.abort();
      clearInterval(timer);
      clearTimeout(quietTimer);
    };
  }, [active, round, startCursor, fetchFn]);

  const again = useCallback(() => setRound((r) => r + 1), []);
  return { heard, over, quiet, again };
}
