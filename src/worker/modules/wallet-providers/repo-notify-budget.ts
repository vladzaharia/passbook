import { all } from '../../platform/db.ts';

export interface NotifiedSince {
  used: number;
  /** The oldest counted notification, when the 24 h window rolls on. */
  oldest: number | null;
  /** The newest Google quota refusal in the window: the object's budget is spent from then (section 7). */
  quotaAt: number | null;
}

/** Which Google object: one instance, or the live Google copy of a pass. */
export type NotifyTarget = { instanceId: string } | { passId: string };

/**
 * Notifying messages Google accepted for the object since `since`, from the message ledger
 * (docs/design/wallet-providers/google-messages.md section 7). A message a schedule applied counts like any other.
 */
export async function googleNotifiedSince(
  db: D1Database,
  target: NotifyTarget,
  since: number,
): Promise<NotifiedSince> {
  const rows = await all<{ state: string; notify: number; reason: string | null; at: number }>(
    db,
    `SELECT m.state, m.notify, m.reason, COALESCE(m.settled_at, m.created_at) AS at FROM wallet_google_messages m
     JOIN wallet_provider_instances i ON i.id = m.instance_id
     WHERE ${
       'instanceId' in target
         ? 'i.id = ?'
         : `i.pass_id = ? AND i.provider = 'google' AND i.retirement_requested_at IS NULL
       AND i.credential_generation = (SELECT MAX(l.credential_generation) FROM wallet_provider_instances l
         WHERE l.pass_id = i.pass_id AND l.provider = 'google' AND l.retirement_requested_at IS NULL)`
     }
       AND COALESCE(m.settled_at, m.created_at) > ?
       AND (m.state = 'notified' OR (m.state = 'unknown' AND m.notify = 1) OR m.reason = 'quota')
     ORDER BY at`,
    ['instanceId' in target ? target.instanceId : target.passId, since],
  );
  // An unknown notifying message may have arrived, so it counts; a quota refusal spends the window.
  const counted = rows.filter(
    (r) => r.state === 'notified' || (r.state === 'unknown' && r.notify === 1),
  );
  const quota = rows.filter((r) => r.reason === 'quota');
  return {
    used: counted.length,
    oldest: counted[0]?.at ?? null,
    quotaAt: quota.length ? Math.max(...quota.map((r) => r.at)) : null,
  };
}

/** The pass's live Google copy against the window; any other provider has no notifying call. */
export async function providerNotifiedSince(
  db: D1Database,
  passId: string,
  provider: string,
  since: number,
): Promise<NotifiedSince> {
  if (provider !== 'google') return { used: 0, oldest: null, quotaAt: null };
  return googleNotifiedSince(db, { passId }, since);
}
