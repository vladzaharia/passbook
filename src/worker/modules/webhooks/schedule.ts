const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Wait after failed attempt n (index n - 1). The ninth failure is final. */
export const RETRY_DELAYS_MS = [
  MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
  24 * HOUR,
] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const JITTER = 0.1;
export const RETRY_AFTER_CAP_MS = 6 * HOUR;
/** A crash after the attempt is claimed retries after this. */
export const CLAIM_HOLD_MS = 5 * MINUTE;
export const DISABLE_AFTER_MS = 72 * HOUR;
export const DISABLE_AFTER_FAILURES = 10;

/** `Retry-After` as a delay in ms: delta-seconds or an HTTP date. Null when absent or unusable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Milliseconds until the next try after attempt `attempt` failed, or null when it was the last.
 * `random` is in [0, 1). A 429 or 503 may carry `retryAfterMs`, which lengthens the wait up to 6 h.
 */
export function retryDelay(
  attempt: number,
  random: number,
  retryAfterMs: number | null = null,
): number | null {
  const base = RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  const scheduled = Math.round(base * (1 - JITTER + 2 * JITTER * random));
  return retryAfterMs === null
    ? scheduled
    : Math.max(scheduled, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
}

export function randomUnit(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 0x1_0000_0000;
}
