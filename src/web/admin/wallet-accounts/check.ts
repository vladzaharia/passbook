/** A check counts for 24 hours, the server's window for turning a wallet On. */
export const CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one freshness rule, for the credential pill and the gate. `serverFresh` is the server's
 * answer where it gives one (the enrolment's prerequisite for its source); else the clock decides.
 */
export function checkFresh(verifiedAt: number | null, now: number, serverFresh?: boolean): boolean {
  if (serverFresh !== undefined) return serverFresh;
  return verifiedAt !== null && now - verifiedAt <= CHECK_WINDOW_MS;
}
