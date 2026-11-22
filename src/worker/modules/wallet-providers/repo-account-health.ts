import { first } from '../../platform/db.ts';

/**
 * Whether the account's source credential last failed its check. The daily and on-demand checks write one
 * row each; the newest decides, so a later pass clears it. An account with no check, or no source
 * credential yet, is not failing: only a check says so (Q6).
 */
export async function accountCheckFailing(db: D1Database, accountId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT c.ok FROM wallet_provider_accounts a
    JOIN wallet_credential_checks c ON c.credential_id = a.credential_source_id
    WHERE a.id = ? ORDER BY c.checked_at DESC, c.id DESC LIMIT 1`,
    [accountId],
  );
  return row?.ok === 0;
}
