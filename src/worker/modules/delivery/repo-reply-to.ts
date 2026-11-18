import { first, run } from '../../platform/db.ts';

export interface ReplyToRow {
  address: string;
  token_hash: string | null;
  expires_at: number | null;
  sent_at: number | null;
  confirmed_at: number | null;
}

export const getReplyTo = (db: D1Database, orgId: string) =>
  first<ReplyToRow>(
    db,
    'SELECT address, token_hash, expires_at, sent_at, confirmed_at FROM org_reply_to WHERE org_id = ?',
    [orgId],
  );

/** A new pending address (or a new link for the same one); replaces any earlier confirmation. */
export async function putPendingReplyTo(
  db: D1Database,
  orgId: string,
  address: string,
  tokenHash: string,
  expiresAt: number,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT INTO org_reply_to (org_id, address, token_hash, expires_at, sent_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (org_id) DO UPDATE SET address = excluded.address, token_hash = excluded.token_hash,
       expires_at = excluded.expires_at, sent_at = excluded.sent_at,
       confirmed_at = CASE WHEN org_reply_to.address = excluded.address
         THEN org_reply_to.confirmed_at ELSE NULL END`,
    [orgId, address, tokenHash, expiresAt, now],
  );
}

export const deleteReplyTo = (db: D1Database, orgId: string) =>
  run(db, 'DELETE FROM org_reply_to WHERE org_id = ?', [orgId]);

/** Single use: the matching, unexpired token confirms the address and is cleared. */
export async function confirmReplyToRow(
  db: D1Database,
  orgId: string,
  address: string,
  tokenHash: string,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE org_reply_to SET confirmed_at = ?, token_hash = NULL, expires_at = NULL
      WHERE org_id = ? AND address = ? AND token_hash = ? AND expires_at > ?`,
    [now, orgId, address, tokenHash, now],
  );
  return changes === 1;
}
