/**
 * When this browser session first opened the quickstart. It starts the funnel's clock: the time to a first pass
 * counts the sign-in. Local storage, so a sign-in link opened in a new tab keeps it; a view older than a day is dropped. Never sent anywhere but the sandbox create call,
 * which the server clamps to 24 hours.
 */
const DAY = 24 * 60 * 60 * 1000;
const KEY = 'pb.developers.quickstart.viewedAt';

export function readViewedAt(): number | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const at = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(at) && at > 0 && Date.now() - at < DAY ? at : undefined;
  } catch {
    // Storage blocked: the server starts the clock when the sandbox is made.
    return undefined;
  }
}

/** The first view wins; a reload or a return from sign-in keeps it. */
export function markViewed(now = Date.now()): number {
  const known = readViewedAt();
  if (known !== undefined) return known;
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    // Storage blocked: nothing to keep.
  }
  return now;
}
