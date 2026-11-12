import type { Envelope } from '../../platform/crypto.ts';
import { batch, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import {
  type SamsungFetchSnapshot,
  samsungPassJsonCurrentSql,
  samsungSnapshotParams,
  samsungSnapshotPredicate,
} from './repo-callbacks.ts';

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
      AND r.promoted_at IS NOT NULL AND ${samsungPassJsonCurrentSql}
    ON CONFLICT DO NOTHING`,
    [
      claim.tokenHash,
      claim.claimId,
      claim.expiresAt,
      claim.now,
      ...samsungSnapshotParams(snapshot),
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

/** Replay reservation never promotes a ref without independently verified market eligibility. */
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
  /** An unsigned routing hint, never an installation observation. */
  countryHint: string | null;
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
       signed_at, received_at, kek_version, iv, wrapped_dek, ciphertext)
      SELECT ?, r.id, i.id, i.account_id, i.org_id, i.mode, op.version, 'state_callback',
        ?, ?, ?, ?, ?, ? ${joins}
      WHERE changes() = 1 AND ${samsungSnapshotPredicate()} AND r.promoted_at IS NOT NULL
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
        claim.now,
        ...samsungSnapshotParams(snapshot),
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
  const results = await batch(db, statements);
  return results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
}
