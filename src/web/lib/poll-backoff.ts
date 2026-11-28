/**
 * One place where a poller slows down when the server says 429: `Retry-After` when it came, otherwise doubling
 * from the poll's own pace up to 60 s. A success returns it to normal pace. The Workbench shell holds this file, so
 * the store that says "paused" (poll-hold.ts) plugs in through `reportPolls` when a tool loads.
 */
export const BACKOFF_CAP_MS = 60_000;

interface Limited {
  status: number;
  retryAfter?: number;
}

export const isLimited = (e: unknown): e is Limited =>
  typeof e === 'object' && e !== null && (e as Limited).status === 429;

/** The wait after the `streak`-th 429 in a row, or null when `error` is not a 429. */
export function backoffMs(ms: number, error: unknown, streak: number): number | null {
  if (!isLimited(error)) return null;
  const sent = error.retryAfter;
  return sent && sent > 0 ? Math.max(ms, sent * 1000) : Math.min(BACKOFF_CAP_MS, ms * 2 ** streak);
}

type Report = (key: string, until: number | null) => void;
let report: Report | undefined;

export function reportPolls(fn: Report): void {
  report = fn;
}

interface PollQuery {
  queryHash: string;
  state: { error: unknown; errorUpdatedAt: number };
}

const streaks = new WeakMap<object, { at: number; n: number }>();
const intervals = new Map<number, (query: PollQuery) => number>();

/** A react-query `refetchInterval` every `ms` that backs off on 429. Stable per `ms`, so renders keep the timer. */
export function pollEvery(ms: number): (query: PollQuery) => number {
  let fn = intervals.get(ms);
  if (!fn) {
    fn = (query) => {
      const { error, errorUpdatedAt } = query.state;
      if (!isLimited(error)) {
        streaks.delete(query);
        report?.(query.queryHash, null);
        return ms;
      }
      let s = streaks.get(query);
      if (s?.at !== errorUpdatedAt) {
        s = { at: errorUpdatedAt, n: (s?.n ?? 0) + 1 };
        streaks.set(query, s);
      }
      const wait = backoffMs(ms, error, s.n) ?? ms;
      report?.(query.queryHash, errorUpdatedAt + wait);
      return wait;
    };
    intervals.set(ms, fn);
  }
  return fn;
}
