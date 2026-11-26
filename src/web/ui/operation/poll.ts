/**
 * How long to wait before the next poll: every 1 s for the first 10 s, every 2 s up to 60 s, then
 * every 5 s. The server's `pollAfterMs` is a floor, a hidden tab polls every 30 s, and a 429 waits
 * out its Retry-After.
 */
export function pollDelay({
  sinceStartMs,
  hidden = false,
  floorMs = 0,
  retryAfterMs = null,
}: {
  sinceStartMs: number;
  hidden?: boolean;
  floorMs?: number;
  retryAfterMs?: number | null;
}): number {
  const base = sinceStartMs < 10_000 ? 1000 : sinceStartMs < 60_000 ? 2000 : 5000;
  const wait = Math.max(base, floorMs, hidden ? 30_000 : 0);
  return retryAfterMs !== null ? Math.max(wait, retryAfterMs) : wait;
}
