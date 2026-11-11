import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { accountCredentialLineageSql } from './repo-account-lineage.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';

export { saveAccountConfiguration, transitionAccount } from './repo-account-writes.ts';

export type WalletProviderRetirementProof = {
  orgId: string;
  mode: WalletProviderScope['mode'];
  accountId: string;
  accountRevision: number;
  instanceId: string;
  operationId: string;
  version: number;
  claimHash: string;
  credentialKeysetCommitment: string;
  projectionReleaseId: string;
} & (
  | {
      provider: 'google';
      passId: string;
      identityProjectionReleaseId: string;
      credentialGeneration: number;
    }
  | { provider: 'samsung'; refHash: string }
);

export interface SamsungPromotedRefreshProof {
  orgId: string;
  mode: WalletProviderScope['mode'];
  accountId: string;
  accountRevision: number;
  credentialKeysetCommitment: string;
  projectionReleaseId: string;
  instanceId: string;
  refHash: string;
  operationVersion: number;
}

export interface AccountRow {
  id: string;
  org_id: string;
  mode: WalletProviderScope['mode'];
  provider: WalletProviderScope['provider'];
  revision: number;
  credential_id: string | null;
  revoked_at: number | null;
  updated_at: number;
  kek_version: number | null;
  iv: number[] | Uint8Array | ArrayBuffer | null;
  wrapped_dek: number[] | Uint8Array | ArrayBuffer | null;
  ciphertext: number[] | Uint8Array | ArrayBuffer | null;
}

/** Account and its current envelope are selected in one database snapshot. */
export function findAccount(
  db: D1Database,
  scope: WalletProviderScope,
): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, a.revision,
      a.credential_id, a.revoked_at, a.updated_at,
      c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
    FROM wallet_provider_accounts a
    LEFT JOIN wallet_provider_credentials c ON c.id = a.credential_id
      AND c.account_id = a.id AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    WHERE a.org_id = ? AND a.mode = ? AND a.provider = ?`,
    [scope.orgId, scope.mode, scope.provider],
  );
}

/** Recheck the singleton and all retained identities in the same snapshot as the account. */
export function findAccountWithCredentialKeyset(
  db: D1Database,
  scope: WalletProviderScope,
  credentialKeysetCommitment: string,
): Promise<AccountRow | null> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, a.revision,
      a.credential_id, a.revoked_at, a.updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
    FROM wallet_provider_accounts a
    LEFT JOIN wallet_provider_credentials c ON c.id = a.credential_id
      AND c.account_id = a.id AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    WHERE a.org_id = ? AND a.mode = ? AND a.provider = ?
      AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql}`,
    [scope.orgId, scope.mode, scope.provider, credentialKeysetCommitment],
  );
}

/** Pin cleanup to one immutable object generation; the surrounding query proves the claim. */
export const googleRetirementTargetSql =
  'i.pass_id = ? AND i.identity_projection_release_id = ? AND i.credential_generation = ?';

/** Only the current claimed revoke can read credentials for its exact external target. */
export function findRetirementAccount(
  db: D1Database,
  proof: WalletProviderRetirementProof,
  now: number,
): Promise<AccountRow | null> {
  const target =
    proof.provider === 'google'
      ? googleRetirementTargetSql
      : `EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id AND ref.ref_hash = ?
        AND ref.credential_keyset_commitment = i.credential_keyset_commitment)`;
  const targetValues =
    proof.provider === 'google'
      ? [proof.passId, proof.identityProjectionReleaseId, proof.credentialGeneration]
      : [proof.refHash];
  // The claim is necessarily a revoke. Omitting the unreachable upsert branch keeps
  // D1's expression depth bounded while all fences still share this read's snapshot.
  return first(
    db,
    `WITH clock(now_ms) AS (SELECT ?)
    SELECT a.id, a.org_id, a.mode, a.provider, a.revision, a.credential_id,
      a.revoked_at, a.updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
    FROM wallet_provider_accounts a JOIN wallet_provider_credentials c
      ON c.id = a.credential_id AND c.account_id = a.id AND c.org_id = a.org_id
      AND c.mode = a.mode AND c.provider = a.provider
    JOIN wallet_provider_instances i ON i.account_id = a.id AND i.org_id = a.org_id
      AND i.mode = a.mode AND i.provider = a.provider
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id AND op.instance_id = i.id
    CROSS JOIN clock
    WHERE (a.org_id = ? AND a.mode = ? AND a.provider = ? AND a.id = ? AND a.revision = ?
      AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL)
      AND (i.id = ? AND i.lifecycle = 'revoking'
        AND op.id = ? AND op.version = ? AND op.kind = 'revoke' AND op.state = 'claimed')
      AND (op.claim_hash = ? AND op.claim_expires_at > clock.now_ms AND op.projection_release_id = ?
        AND op.credential_keyset_commitment = ? AND i.credential_keyset_commitment = op.credential_keyset_commitment)
      AND ${credentialRefKeysetSql}
      AND (${target}) AND (${walletInstanceOperationCurrentSql('i', 'op', 'clock.now_ms', 'revoke')})`,
    [
      now,
      proof.orgId,
      proof.mode,
      proof.provider,
      proof.accountId,
      proof.accountRevision,
      proof.instanceId,
      proof.operationId,
      proof.version,
      proof.claimHash,
      proof.projectionReleaseId,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
      ...targetValues,
    ],
  );
}

/** Existing promoted references can refresh only against the current pass and projection proof. */
export function findSamsungPromotedRefreshAccount(
  db: D1Database,
  proof: SamsungPromotedRefreshProof,
  now: number,
): Promise<AccountRow | null> {
  return first(
    db,
    `WITH clock(now_ms) AS (SELECT ?)
    SELECT a.id, a.org_id, a.mode, a.provider, a.revision, a.credential_id,
      a.revoked_at, a.updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
    FROM wallet_provider_accounts a JOIN wallet_provider_credentials c
      ON c.id = a.credential_id AND c.account_id = a.id AND c.org_id = a.org_id
      AND c.mode = a.mode AND c.provider = a.provider
    JOIN wallet_provider_instances i ON i.account_id = a.id AND i.org_id = a.org_id
      AND i.mode = a.mode AND i.provider = a.provider
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id AND op.instance_id = i.id
    JOIN wallet_samsung_fetch_refs ref ON ref.instance_id = i.id AND ref.ref_hash = ?
      AND ref.promoted_at IS NOT NULL AND ref.retired_at IS NULL
      AND ref.credential_keyset_commitment = i.credential_keyset_commitment
    CROSS JOIN clock
    WHERE a.org_id = ? AND a.mode = ? AND a.provider = 'samsung' AND a.id = ? AND a.revision = ?
      AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL AND i.id = ? AND i.lifecycle = 'active'
      AND op.kind = 'upsert' AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
      AND op.version = ? AND op.projection_release_id = ?
      AND op.credential_keyset_commitment = ? AND i.credential_keyset_commitment = op.credential_keyset_commitment
      AND ${credentialRefKeysetSql} AND ${walletInstanceOperationCurrentSql('i', 'op', 'clock.now_ms')}`,
    [
      now,
      proof.refHash,
      proof.orgId,
      proof.mode,
      proof.accountId,
      proof.accountRevision,
      proof.instanceId,
      proof.operationVersion,
      proof.projectionReleaseId,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
    ],
  );
}

/** A tombstone resolves the credential bound to its original provider-verified release. */
export function findSamsungTombstoneCredential(
  db: D1Database,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    refHash: string;
    credentialKeysetCommitment: string;
  },
): Promise<(AccountRow & { provider_identity_hash: string }) | null> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, t.account_revision AS revision,
      e.credential_id, NULL AS revoked_at,
      e.created_at AS updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext,
      t.provider_identity_hash
    FROM wallet_samsung_tombstones t
    JOIN wallet_provider_accounts a ON a.id = t.account_id AND a.org_id = t.org_id
      AND a.mode = t.mode AND a.provider = 'samsung'
    JOIN wallet_provider_account_events e ON e.account_id = a.id AND e.org_id = a.org_id
      AND e.mode = a.mode AND e.provider = a.provider AND e.revision = t.account_revision AND e.kind = 'configure'
    JOIN wallet_provider_credentials c ON c.id = e.credential_id AND c.account_id = a.id
      AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    JOIN template_candidates candidate ON candidate.id = t.candidate_id AND candidate.org_id = t.org_id
      AND candidate.mode = t.mode AND candidate.provider = 'samsung'
      AND candidate.provider_account_id = t.account_id AND candidate.provider_account_revision = t.account_revision
      AND candidate.provider_identity_hash = t.provider_identity_hash
      AND candidate.credential_keyset_commitment = t.credential_keyset_commitment
    JOIN template_releases r ON r.id = t.release_id AND r.candidate_id = candidate.id
      AND r.org_id = t.org_id AND r.mode = t.mode AND r.provider = 'samsung' AND r.source = 'approved'
      AND r.credential_keyset_commitment = t.credential_keyset_commitment
    JOIN template_approvals approval ON approval.id = r.approval_id AND approval.candidate_id = candidate.id
      AND approval.candidate_hash = candidate.candidate_hash
      AND approval.credential_keyset_commitment = t.credential_keyset_commitment
    WHERE t.ref_hash = ? AND t.org_id = ? AND t.mode = ? AND t.account_id = ? AND t.account_revision = ?
      AND t.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history h
        WHERE h.candidate_id = candidate.id AND h.org_id = t.org_id AND h.mode = t.mode
          AND h.account_id = t.account_id AND h.account_revision = t.account_revision
          AND h.credential_keyset_commitment = t.credential_keyset_commitment
          AND h.provider_identity_hash = t.provider_identity_hash AND h.candidate_hash = candidate.candidate_hash
          AND h.card_type = json_extract(candidate.projection_json, '$.cardType')
          AND h.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
          AND h.country_code = json_extract(candidate.projection_json, '$.countryCode')
          AND h.testing_mode_off = 'Y' AND h.verified_at <= r.created_at AND r.created_at < h.expires_at)`,
    [
      input.refHash,
      input.orgId,
      input.mode,
      input.accountId,
      input.accountRevision,
      input.credentialKeysetCommitment,
      input.credentialKeysetCommitment,
    ],
  );
}

export async function hasUnretiredInstances(db: D1Database, accountId: string): Promise<boolean> {
  const row = await first<{ present: number }>(
    db,
    "SELECT 1 AS present FROM wallet_provider_instances WHERE account_id = ? AND lifecycle != 'retired' LIMIT 1",
    [accountId],
  );
  return row !== null;
}
