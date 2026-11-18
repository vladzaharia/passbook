import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import {
  type SamsungFetchSnapshot,
  samsungPassJsonCurrentSql,
  samsungSnapshotParams,
  samsungSnapshotPredicate,
} from './repo-callbacks.ts';
import { samsungInitialWindowSql } from './repo-callbacks-window.ts';

export type SamsungCardEvent = 'ADDED' | 'DELETED' | 'UPDATED' | 'PROVISIONED';

export interface SamsungReplayClaim {
  tokenHash: string;
  claimId: string;
  expiresAt: number;
  now: number;
}

const joins = `FROM wallet_samsung_fetch_refs r
  JOIN wallet_provider_instances i ON i.id = r.instance_id
  JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    AND op.instance_id = i.id AND op.version = i.desired_version
  JOIN passes p ON p.id = i.pass_id CROSS JOIN (SELECT ? AS now) clock`;

function claimStatement(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  rawPassJson: string,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO wallet_samsung_auth_replays (token_hash, claim_id, expires_at)
    SELECT ?, ?, ? ${joins} WHERE ${samsungSnapshotPredicate()}
      AND ${samsungInitialWindowSql} AND ${samsungPassJsonCurrentSql}
    ON CONFLICT DO NOTHING`,
    [
      claim.tokenHash,
      claim.claimId,
      claim.expiresAt,
      claim.now,
      ...samsungSnapshotParams(snapshot),
      claim.now,
      claim.now,
      rawPassJson,
    ],
  );
}

function validClaim(c: SamsungReplayClaim): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(c.tokenHash) &&
    !!c.claimId &&
    Number.isSafeInteger(c.now) &&
    Number.isSafeInteger(c.expiresAt) &&
    c.expiresAt > c.now
  );
}

/**
 * Replay reservation never promotes a ref: only a verified ADDED receipt does. A ref may answer
 * inside its initial window (a delivered wrapper) or once promoted.
 */
export async function claimSamsungFetch(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  rawPassJson: string,
): Promise<boolean> {
  if (!validClaim(claim)) return false;
  const results = await batch(db, [
    stmt(
      db,
      `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ? AND ${credentialRefKeysetSql}`,
      [claim.now, snapshot.credentialKeysetCommitment],
    ),
    claimStatement(db, snapshot, claim, rawPassJson),
  ]);
  return results[1]?.meta.changes === 1;
}

export interface SamsungReceipt {
  id: string;
  signedAt: number;
  envelope: Envelope;
  /** From the query, which the token does not sign: a routing hint until a verified ADDED. */
  countryHint: string | null;
  event: SamsungCardEvent | null;
  /** The validated `x-request-id`; with the token hash it is the delivery's idempotency key. */
  requestId: string;
}

/** True when this exact delivery (token and request id) already left a receipt. */
export async function samsungDeliveryRecorded(
  db: D1Database,
  tokenHash: string,
  requestId: string,
): Promise<boolean> {
  const row = await first(
    db,
    'SELECT 1 FROM wallet_samsung_callback_receipts WHERE token_hash = ? AND request_id = ?',
    [tokenHash, requestId],
  );
  return row !== null;
}

/**
 * The effect of a receipt, applied in the receipt's own batch and only if it was inserted (so the
 * fences of the receipt held): ADDED promotes the ref once, keeps its market and marks the
 * instance saved; DELETED records the holder's removal. Nothing here erases or revokes.
 */
function effectStatements(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt,
): D1PreparedStatement[] {
  const inserted = `EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts rc
    WHERE rc.id = ? AND rc.event = ?)`;
  if (receipt.event === 'DELETED')
    return [
      stmt(
        db,
        `UPDATE wallet_provider_instances SET holder_removed_at = MAX(COALESCE(holder_removed_at, 0), ?)
        WHERE id = ? AND ${inserted}`,
        [claim.now, snapshot.instanceId, receipt.id, 'DELETED'],
      ),
    ];
  if (receipt.event !== 'ADDED') return [];
  const statements = [
    stmt(
      db,
      `UPDATE wallet_provider_instances SET saved_at = MAX(COALESCE(saved_at, 0), ?)
      WHERE id = ? AND ${inserted}`,
      [claim.now, snapshot.instanceId, receipt.id, 'ADDED'],
    ),
  ];
  // The market is the ADDED event's own cc2, never a hint from an earlier or other callback.
  if (receipt.countryHint)
    statements.unshift(
      stmt(
        db,
        `UPDATE wallet_samsung_fetch_refs SET promoted_at = ?, market_cc2 = ?
        WHERE id = ? AND promoted_at IS NULL AND retired_at IS NULL AND ${inserted}`,
        [claim.now, receipt.countryHint, snapshot.referenceId, receipt.id, 'ADDED'],
      ),
    );
  return statements;
}

/** Store untrusted raw bytes encrypted only after authenticated replay-safe admission. */
export async function claimSamsungReceipt(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt,
  rawPassJson: string,
): Promise<boolean> {
  if (
    !validClaim(claim) ||
    !Number.isSafeInteger(receipt.signedAt) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.requestId) ||
    (receipt.countryHint !== null && !/^[A-Z]{2}$/.test(receipt.countryHint))
  )
    return false;
  const { envelope } = receipt;
  const statements = [
    stmt(
      db,
      `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ? AND ${credentialRefKeysetSql}`,
      [claim.now, snapshot.credentialKeysetCommitment],
    ),
    claimStatement(db, snapshot, claim, rawPassJson),
    stmt(
      db,
      `INSERT INTO wallet_samsung_callback_receipts
      (id, ref_id, instance_id, account_id, org_id, mode, operation_version, kind,
       signed_at, received_at, kek_version, iv, wrapped_dek, ciphertext,
       event, cc2, token_hash, request_id)
      SELECT ?, r.id, i.id, i.account_id, i.org_id, i.mode, op.version, 'state_callback',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${joins}
      WHERE changes() = 1 AND ${samsungSnapshotPredicate()} AND ${samsungInitialWindowSql}
        AND ${samsungPassJsonCurrentSql}
        AND EXISTS (SELECT 1 FROM wallet_samsung_auth_replays replay
          WHERE replay.token_hash = ? AND replay.claim_id = ?)`,
      [
        receipt.id,
        receipt.signedAt,
        claim.now,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        receipt.event,
        receipt.countryHint,
        claim.tokenHash,
        receipt.requestId,
        claim.now,
        ...samsungSnapshotParams(snapshot),
        claim.now,
        claim.now,
        rawPassJson,
        claim.tokenHash,
        claim.claimId,
      ],
    ),
  ];
  if (receipt.countryHint) {
    statements.push(
      stmt(
        db,
        `INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at)
      SELECT ref_id, ?, ? FROM wallet_samsung_callback_receipts
      WHERE id = ? AND changes() = 1 AND ${credentialRefKeysetSql}
      ON CONFLICT(ref_id, country_code) DO NOTHING`,
        [receipt.countryHint, claim.now, receipt.id, snapshot.credentialKeysetCommitment],
      ),
    );
    statements.push(
      stmt(
        db,
        `INSERT INTO wallet_provider_instance_dirty (instance_id, generation)
      SELECT instance_id, 1 FROM wallet_samsung_callback_receipts
      WHERE id = ? AND changes() = 1 AND ${credentialRefKeysetSql}
      ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1`,
        [receipt.id, snapshot.credentialKeysetCommitment],
      ),
    );
  }
  statements.push(...effectStatements(db, snapshot, claim, receipt));
  const results = await batch(db, statements);
  return results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
}
