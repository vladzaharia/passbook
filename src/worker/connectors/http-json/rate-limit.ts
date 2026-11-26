import { remainingFromHeaders, waitFromHeaders } from '../lib/http.ts';
import { ConnectorError } from '../types.ts';

/** A 429 asking for this long or less is retried once inside the connector. */
export const INLINE_RETRY_MS = 5_000;
/** A saved wait of this long or less is slept through before the next request. */
export const MAX_SLEEP_MS = 30_000;

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ConnectorError('TIMEOUT'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConnectorError('TIMEOUT'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** When a 2xx says no requests are left, the time (ms) the window resets; otherwise undefined. */
export function exhaustedUntil(headers: Headers, now: number): number | undefined {
  if (remainingFromHeaders(headers) !== 0) return undefined;
  const wait = waitFromHeaders(headers, now);
  return wait === undefined ? undefined : now + wait;
}

/** Honors a saved wait before a request: sleeps a short one, refuses a long one without calling out. */
export async function holdUntil(
  until: number | undefined,
  now: number,
  signal: AbortSignal,
): Promise<void> {
  if (until === undefined || until <= now) return;
  const wait = until - now;
  if (wait > MAX_SLEEP_MS) throw new ConnectorError('RATE_LIMITED', { retryAfterMs: wait });
  await sleep(wait, signal);
}
