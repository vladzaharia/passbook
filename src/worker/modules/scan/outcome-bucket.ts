/** A full place turns the scan away, so Refused counts it even though the door held it as a heads-up. */
export const bucketOutcome = (
  outcome: 'ok' | 'heads_up' | 'refused' | null,
  reason: string | null,
): 'ok' | 'heads_up' | 'refused' =>
  outcome === 'heads_up' && reason === 'capacity_full' ? 'refused' : (outcome ?? 'refused');

/** The same buckets as SQL over `scans s`. */
export const HEADS_UP_SQL = "(s.outcome IS 'heads_up' AND s.reason IS NOT 'capacity_full')";
export const REFUSED_SQL =
  "(s.outcome = 'refused' OR (s.outcome = 'heads_up' AND s.reason = 'capacity_full'))";
