import { all, first, run } from '../../platform/db.ts';

/** Read the JSON belonging to the queued artifact, never the latest pass revision. */
export function passJsonForArtifact(
  db: D1Database,
  passId: string,
  objectKey: string,
  version: number,
): Promise<{ pass_json: string | null } | null> {
  return first(
    db,
    `SELECT pass_json FROM pass_versions
     WHERE pass_id = ? AND object_key = ? AND version <= ? ORDER BY version DESC LIMIT 1`,
    [passId, objectKey, version],
  );
}

/** An expired lease belongs to the sweeper, even if it has not reclaimed it yet. */
export async function hasDeliveryLease(
  db: D1Database,
  id: string,
  lease: string,
  now: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM outbox
       WHERE id = ? AND state = 'processing' AND lease = ? AND available_at > ?`,
      [id, lease, now],
    )) !== null
  );
}

export const EMAIL_OUTCOME_UNKNOWN = 'EMAIL_OUTCOME_UNKNOWN';

/** A late provider response may resolve an already-expired unknown attempt. */
export async function completeProviderAttempt(
  db: D1Database,
  id: string,
  lease: string,
  messageId: string,
  now: number,
): Promise<boolean> {
  const result = await first<{ id: string }>(
    db,
    `UPDATE outbox SET state = 'sent', lease = NULL, finished_at = ?, error_code = NULL,
       provider_id = ?, coalesce_key = NULL
     WHERE id = ? AND kind = 'email'
       AND ((state = 'processing' AND lease = ?) OR (state = 'partial' AND error_code = ?))
     RETURNING id`,
    [now, messageId, id, lease, EMAIL_OUTCOME_UNKNOWN],
  );
  return result !== null;
}

/** If finalization fails, retain the provider id for the next settlement. */
export async function rememberProviderAcceptance(
  db: D1Database,
  id: string,
  lease: string,
  messageId: string,
): Promise<void> {
  await run(
    db,
    `UPDATE outbox SET provider_id = ?
     WHERE id = ? AND kind = 'email'
       AND ((state = 'processing' AND lease = ?) OR (state = 'partial' AND error_code = ?))`,
    [messageId, id, lease, EMAIL_OUTCOME_UNKNOWN],
  );
}

/** Never return an attempted provider call to the automatic retry queue. */
export async function settleUncertainEmails(
  db: D1Database,
  now: number,
  options: { expiredOnly: boolean; id?: string },
): Promise<number> {
  const rows = await all<{ id: string }>(
    db,
    `UPDATE outbox SET state = CASE WHEN provider_id IS NULL THEN 'partial' ELSE 'sent' END,
       lease = NULL, finished_at = ?, coalesce_key = NULL,
       error_code = CASE WHEN provider_id IS NULL THEN ? ELSE NULL END
     WHERE kind = 'email' AND error_code = ? AND (? IS NULL OR id = ?)
       AND ((state = 'processing' AND (? = 0 OR available_at < ?))
         OR (state = 'partial' AND provider_id IS NOT NULL))
     RETURNING id`,
    [
      now,
      EMAIL_OUTCOME_UNKNOWN,
      EMAIL_OUTCOME_UNKNOWN,
      options.id ?? null,
      options.id ?? null,
      options.expiredOnly ? 1 : 0,
      now,
    ],
  );
  return rows.length;
}
