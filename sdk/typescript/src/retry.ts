/** Longest `Retry-After` the SDK will wait out; a longer one is returned to the caller as the error. */
export const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;

/** Milliseconds from a `Retry-After` value (seconds or an HTTP date), or null when absent or unusable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Exponential backoff with jitter: about base, 2x, 4x, capped. */
export function backoffMs(attempt: number, baseMs: number, random = Math.random()): number {
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt) * (0.5 + random / 2);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
