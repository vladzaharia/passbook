import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, first, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';

export {
  putSamsungTombstone,
  type SamsungRetirementScope,
} from './repo-callbacks-tombstone-retirement.ts';

export interface SamsungTombstoneScope {
  orgId: string;
  mode: Mode;
  accountId: string;
  accountRevision: number;
  refHash: string;
  credentialKeysetCommitment: string;
}

const noLiveRef = `NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs live_ref
  JOIN wallet_provider_instances live_instance ON live_instance.id = live_ref.instance_id
  WHERE live_ref.ref_hash = tomb.ref_hash AND live_ref.retired_at IS NULL
    AND NOT (live_instance.lifecycle IN ('revoked', 'retired') AND EXISTS (
      SELECT 1 FROM wallet_provider_instance_operations current_op
      WHERE current_op.id = live_instance.desired_operation_id
        AND current_op.instance_id = live_instance.id
        AND current_op.version = live_instance.desired_version
        AND current_op.kind = 'revoke' AND current_op.state = 'succeeded')))`;

/** Immutable approved credential history is the verifier; no pass or instance FK is retained. */
export function findSamsungTombstones(
  db: D1Database,
  refHash: string,
  credentialKeysetCommitment: string,
): Promise<SamsungTombstoneScope[]> {
  return all<SamsungTombstoneScope>(
    db,
    `SELECT tomb.org_id AS orgId, tomb.mode, tomb.account_id AS accountId,
    tomb.account_revision AS accountRevision, tomb.ref_hash AS refHash,
    tomb.credential_keyset_commitment AS credentialKeysetCommitment FROM wallet_samsung_tombstones tomb
    WHERE tomb.ref_hash = ? AND tomb.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${noLiveRef} ORDER BY tomb.account_revision DESC LIMIT 33`,
    [refHash, credentialKeysetCommitment, credentialKeysetCommitment],
  );
}

export async function samsungTombstoneStillDeleted(
  db: D1Database,
  scope: SamsungTombstoneScope,
): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 FROM wallet_samsung_tombstones tomb
    WHERE tomb.ref_hash = ? AND tomb.org_id = ? AND tomb.mode = ? AND tomb.account_id = ?
      AND tomb.account_revision = ? AND tomb.credential_keyset_commitment = ?
      AND ${credentialRefKeysetSql} AND ${noLiveRef}`,
    [
      scope.refHash,
      scope.orgId,
      scope.mode,
      scope.accountId,
      scope.accountRevision,
      scope.credentialKeysetCommitment,
      scope.credentialKeysetCommitment,
    ],
  );
  return row !== null;
}

/** One global token digest is reserved only if the historical binding still exists. */
export async function claimSamsungTombstoneReplay(
  db: D1Database,
  scope: SamsungTombstoneScope,
  claim: { tokenHash: string; claimId: string; now: number; expiresAt: number },
): Promise<boolean> {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(claim.tokenHash) ||
    !claim.claimId ||
    !Number.isSafeInteger(claim.now) ||
    !Number.isSafeInteger(claim.expiresAt) ||
    claim.expiresAt <= claim.now
  )
    return false;
  const results = await batch(db, [
    stmt(
      db,
      `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ? AND ${credentialRefKeysetSql}`,
      [claim.now, scope.credentialKeysetCommitment],
    ),
    stmt(
      db,
      `INSERT INTO wallet_samsung_auth_replays (token_hash, claim_id, expires_at)
      SELECT ?, ?, ? FROM wallet_samsung_tombstones tomb
      JOIN wallet_provider_account_events approved ON approved.account_id = tomb.account_id
        AND approved.org_id = tomb.org_id AND approved.mode = tomb.mode
        AND approved.provider = 'samsung' AND approved.kind = 'configure'
        AND approved.revision = tomb.account_revision
      WHERE tomb.ref_hash = ? AND tomb.org_id = ? AND tomb.mode = ? AND tomb.account_id = ?
        AND tomb.account_revision = ? AND tomb.credential_keyset_commitment = ?
        AND ${credentialRefKeysetSql} AND ${noLiveRef} ON CONFLICT DO NOTHING`,
      [
        claim.tokenHash,
        claim.claimId,
        claim.expiresAt,
        scope.refHash,
        scope.orgId,
        scope.mode,
        scope.accountId,
        scope.accountRevision,
        scope.credentialKeysetCommitment,
        scope.credentialKeysetCommitment,
      ],
    ),
  ]);
  return results[1]?.meta.changes === 1;
}
