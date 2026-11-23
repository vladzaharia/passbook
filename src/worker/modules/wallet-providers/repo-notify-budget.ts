import { all } from '../../platform/db.ts';

/** Message events of one pass since `since` whose notifying message was sent to `provider`. */
export async function providerNotifiedSince(
  db: D1Database,
  passId: string,
  provider: string,
  since: number,
): Promise<{ used: number; oldest: number | null }> {
  const rows = await all<{ at: number }>(
    db,
    `SELECT at FROM pass_events
     WHERE pass_id = ? AND kind = 'message.applied' AND at > ?
       AND json_extract(data, '$.providers.' || ?) = 'sent'
     ORDER BY at`,
    [passId, since, provider],
  );
  return { used: rows.length, oldest: rows[0]?.at ?? null };
}
