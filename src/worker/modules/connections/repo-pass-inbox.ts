import { all } from '../../platform/db.ts';

// Webhook events and inbox
export interface InboxItem {
  ref: string;
  record: Record<string, unknown> | null;
  deleted: boolean;
}

export async function getInbox(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<InboxItem[]> {
  const rows = await all<{ ref: string; record: string | null; deleted: number }>(
    db,
    'SELECT ref, record, deleted FROM connection_inbox WHERE connection_id = ? AND event_id = ?',
    [connectionId, eventId],
  );
  return rows.map((r) => ({
    ref: r.ref,
    record: r.record ? (JSON.parse(r.record) as Record<string, unknown>) : null,
    deleted: r.deleted === 1,
  }));
}
