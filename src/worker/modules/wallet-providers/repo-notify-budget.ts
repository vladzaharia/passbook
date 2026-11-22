import { all } from '../../platform/db.ts';

/** Message events of one pass since `since` whose notifying message was sent to `provider`. */
export async function providerNotifiedSince(
  db: D1Database,
  passId: string,
  provider: string,
  since: number,
): Promise<{ used: number; oldest: number | null }> {
  // Google's own ledger is the truth (google-messages.md section 7): a message counts once Google took it.
  if (provider === 'google') {
    const rows = await all<{ at: number }>(
      db,
      `SELECT m.settled_at AS at FROM wallet_google_messages m
      JOIN wallet_provider_instances i ON i.id = m.instance_id
      WHERE i.pass_id = ? AND i.provider = 'google' AND m.state = 'notified' AND m.settled_at > ?
      ORDER BY m.settled_at`,
      [passId, since],
    );
    return { used: rows.length, oldest: rows[0]?.at ?? null };
  }
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
