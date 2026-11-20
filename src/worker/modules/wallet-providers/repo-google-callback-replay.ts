import { deleteInBatches } from '../../platform/batched.ts';
import { first } from '../../platform/db.ts';
import type { GoogleCallbackBinding } from './repo-google-callback.ts';

/** Replay reservations only matter until the signed message itself expires. */
export function purgeExpiredGoogleCallbackReplays(db: D1Database, now: number): Promise<number> {
  return deleteInBatches(db, 'wallet_google_callback_replays', 'expires_at <= ?', [now], 5);
}

/** True when this exact signed message (account, nonce, instance, event) already has a receipt. */
export async function isGoogleCallbackRedelivery(
  db: D1Database,
  binding: GoogleCallbackBinding,
  input: { nonceHash: string; eventType: 'save' | 'del'; expiresAt: number },
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS ok FROM wallet_google_callback_receipts receipt
      JOIN wallet_google_callback_replays replay ON replay.account_id = receipt.account_id
        AND replay.nonce_hash = receipt.nonce_hash AND replay.claim_id = receipt.id
      WHERE receipt.account_id = ? AND receipt.nonce_hash = ? AND receipt.instance_id = ?
        AND receipt.org_id = ? AND receipt.mode = ? AND receipt.event_type = ?
        AND receipt.expires_at = ?`,
      [
        binding.accountId,
        input.nonceHash,
        binding.instanceId,
        binding.orgId,
        binding.mode,
        input.eventType,
        input.expiresAt,
      ],
    )) !== null
  );
}
