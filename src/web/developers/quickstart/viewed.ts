/**
 * When this browser session first opened the quickstart. It starts the funnel's clock: the time to a first pass
 * counts the sign-in. Session storage only (it dies with the tab), never sent anywhere but the sandbox create call,
 * which the server clamps to 24 hours.
 */
const KEY = 'pb.developers.quickstart.viewedAt';

export function readViewedAt(): number | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    const at = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    // Storage blocked: the server starts the clock when the sandbox is made.
    return undefined;
  }
}

/** The first view of the session wins; a reload or a return from sign-in keeps it. */
export function markViewed(now = Date.now()): number {
  const known = readViewedAt();
  if (known !== undefined) return known;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // Storage blocked: nothing to keep.
  }
  return now;
}
