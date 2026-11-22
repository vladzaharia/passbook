/**
 * The one hook between the online paths and the offline queue. The server dates a queued read no earlier
 * than the last online contact, so a session poll or an online scan sends what is queued first (30 s at
 * most, and a failed sync does not block). This covers a flaky link that never raised an `offline` event.
 */
let sync: (() => Promise<void>) | null = null;

export function registerSync(fn: (() => Promise<void>) | null) {
  sync = fn;
}

export const syncBeforeOnline = (): Promise<void> => sync?.() ?? Promise.resolve();

/** `run` after the queue is sent; at once (same tick) when no door is syncing. */
export function afterSync<T>(run: () => Promise<T>): Promise<T> {
  const sent = sync?.();
  return sent ? sent.then(run) : run();
}
