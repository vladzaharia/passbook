import { all } from '../../platform/db.ts';

/**
 * Notifying messages of one pass since `since` that `provider` took. Google's own ledger is the truth
 * (google-messages.md section 7): a message counts once Google accepted it as `TEXT_AND_NOTIFY`. The broadcast
 * forecast's `sent` marker counts as well, so a forecast that recorded one is never undone.
 */
export async function providerNotifiedSince(
  db: D1Database,
  passId: string,
  provider: string,
  since: number,
): Promise<{ used: number; oldest: number | null }> {
  const events = await all<{ at: number }>(
    db,
    `SELECT at FROM pass_events
     WHERE pass_id = ? AND kind = 'message.applied' AND at > ?
       AND json_extract(data, '$.providers.' || ?) = 'sent'
     ORDER BY at`,
    [passId, since, provider],
  );
  const ledger =
    provider === 'google'
      ? await all<{ at: number }>(
          db,
          `SELECT m.settled_at AS at FROM wallet_google_messages m
          JOIN wallet_provider_instances i ON i.id = m.instance_id
          WHERE i.pass_id = ? AND i.provider = 'google' AND m.state = 'notified' AND m.settled_at > ?`,
          [passId, since],
        )
      : [];
  const times = [...events, ...ledger].map((row) => row.at).sort((a, b) => a - b);
  return { used: times.length, oldest: times[0] ?? null };
}
