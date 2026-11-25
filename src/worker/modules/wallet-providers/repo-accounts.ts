import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { first } from '../../platform/db.ts';
import { samsungInitialWindowSql } from './repo-callbacks-window.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export { saveAccountConfiguration, transitionAccount } from './repo-account-writes.ts';

export type WalletProviderRetirementProof = {
  orgId: string;
  mode: WalletProviderScope['mode'];
  accountId: string;
  accountRevision: number;
  /** When set, the account is pinned by its epoch (a same-identity rotation keeps it) instead of its revision. */
  authorityEpoch?: number | undefined;
  instanceId: string;
  operationId: string;
  version: number;
  claimHash: string;
  projectionReleaseId: string;
} & (
  | {
      provider: 'google';
      passId: string;
      identityProjectionReleaseId: string;
      credentialGeneration: number;
      /** Absent means 1; the SQL target fails closed for a successor. */
      channelEpoch: number;
    }
  | { provider: 'samsung'; refHash: string }
);

export interface SamsungPromotedRefreshProof {
  orgId: string;
  mode: WalletProviderScope['mode'];
  accountId: string;
  accountRevision: number;
  authorityEpoch?: number | undefined;
  projectionReleaseId: string;
  instanceId: string;
  refHash: string;
  operationVersion: number;
  /** Inbound callbacks may use a ref in its initial window; outbound sync needs a promoted ref. */
  window?: boolean;
}

export interface AccountRow {
  id: string;
  org_id: string;
  mode: WalletProviderScope['mode'];
  provider: WalletProviderScope['provider'];
  revision: number;
  credential_id: string | null;
  /** The new model's source; with `credential_id` it decides presence (account-presence.ts). */
  credential_source_id: string | null;
  revoked_at: number | null;
  updated_at: number;
  /** Moves on a revoke or an identity change, not on a rotation under the same identity. */
  authority_epoch: number;
  kek_version: number | null;
  iv: number[] | Uint8Array | ArrayBuffer | null;
  wrapped_dek: number[] | Uint8Array | ArrayBuffer | null;
  ciphertext: number[] | Uint8Array | ArrayBuffer | null;
  /** The credential version a reference or tombstone was made under; NULL is a legacy envelope. */
  pin_version_id?: string | null;
  /** The enrolment's own HMAC envelope; NULL on a legacy row. */
  hmac_kek_version?: number | null;
  hmac_iv?: number[] | Uint8Array | ArrayBuffer | null;
  hmac_wrapped_dek?: number[] | Uint8Array | ArrayBuffer | null;
  hmac_ciphertext?: number[] | Uint8Array | ArrayBuffer | null;
  /** New-model state the issuance read checks. */
  enabled_at?: number | null;
  platform_hold_at?: number | null;
}

/**
 * The fence revision: a legacy row's `revision`, an enrolment without a legacy envelope its
 * `enrolment_revision`. Both columns and the own-key envelope, for the account selects below.
 */
export const REVISION_EXPR =
  'CASE WHEN a.credential_id IS NULL THEN a.enrolment_revision ELSE a.revision END';
/** The account pin: the epoch when the proof carries one, else the revision (the enrolment gate still applies). */
const pinExpr = (proof: { authorityEpoch?: number | undefined }) =>
  proof.authorityEpoch === undefined ? REVISION_EXPR : 'a.authority_epoch';
const OWN_KEY = 'a.hmac_kek_version, a.hmac_iv, a.hmac_wrapped_dek, a.hmac_ciphertext';
/** An account the runtime can open: a legacy envelope or its own key. */
const OPENABLE =
  '(a.credential_id IS NOT NULL OR a.hmac_ciphertext IS NOT NULL OR a.credential_source_id IS NOT NULL)';

/** Account and its current envelope are selected in one database snapshot. */
export function findAccount(
  db: D1Database,
  scope: WalletProviderScope,
): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, ${REVISION_EXPR} AS revision,
      a.credential_id, a.credential_source_id, a.revoked_at, a.updated_at, a.authority_epoch,
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
): Promise<AccountRow | null> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, ${REVISION_EXPR} AS revision,
      a.credential_id, a.credential_source_id, a.revoked_at, a.updated_at, a.authority_epoch, c.kek_version, c.iv, c.wrapped_dek,
      c.ciphertext, ${OWN_KEY}, a.enabled_at, a.platform_hold_at
    FROM wallet_provider_accounts a
    LEFT JOIN wallet_provider_credentials c ON c.id = a.credential_id
      AND c.account_id = a.id AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    WHERE a.org_id = ? AND a.mode = ? AND a.provider = ?`,
    [scope.orgId, scope.mode, scope.provider],
  );
}

/** Pin cleanup to one immutable object generation; the surrounding query proves the claim. */
export const googleRetirementTargetSql =
  'i.pass_id = ? AND i.identity_projection_release_id = ? AND i.credential_generation = ? AND i.channel_epoch = ?';

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
      ? [
          proof.passId,
          proof.identityProjectionReleaseId,
          proof.credentialGeneration,
          proof.channelEpoch,
        ]
      : [proof.refHash];
  // The claim is necessarily a revoke. Omitting the unreachable upsert branch keeps
  // D1's expression depth bounded while all fences still share this read's snapshot.
  return first(
    db,
    `WITH clock(now_ms) AS (SELECT ?)
    SELECT a.id, a.org_id, a.mode, a.provider, ${REVISION_EXPR} AS revision, a.credential_id,
      a.credential_source_id, a.revoked_at, a.updated_at, a.authority_epoch, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext, ${OWN_KEY}
    FROM wallet_provider_accounts a LEFT JOIN wallet_provider_credentials c
      ON c.id = a.credential_id AND c.account_id = a.id AND c.org_id = a.org_id
      AND c.mode = a.mode AND c.provider = a.provider
    JOIN wallet_provider_instances i ON i.account_id = a.id AND i.org_id = a.org_id
      AND i.mode = a.mode AND i.provider = a.provider
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id AND op.instance_id = i.id
    CROSS JOIN clock
    WHERE (a.org_id = ? AND a.mode = ? AND a.provider = ? AND a.id = ? AND ${pinExpr(proof)} = ?
      AND ${OPENABLE} AND a.revoked_at IS NULL)
      AND (i.id = ? AND i.lifecycle = 'revoking'
        AND op.id = ? AND op.version = ? AND op.kind = 'revoke' AND op.state = 'claimed')
      AND (op.claim_hash = ? AND op.claim_expires_at > clock.now_ms AND op.projection_release_id = ?
        AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = op.credential_keyset_commitment)
      AND (${target}) AND (${walletInstanceOperationCurrentSql('i', 'op', 'clock.now_ms', 'revoke', proof.authorityEpoch !== undefined)})`,
    [
      now,
      proof.orgId,
      proof.mode,
      proof.provider,
      proof.accountId,
      proof.authorityEpoch ?? proof.accountRevision,
      proof.instanceId,
      proof.operationId,
      proof.version,
      proof.claimHash,
      proof.projectionReleaseId,
      ...targetValues,
    ],
  );
}

/**
 * A promoted reference can use the account only against the current pass and projection proof.
 * With `window`, so can one still inside its initial window: the first Get Card Data and the ADDED
 * that promotes it, which are inbound only. Outbound notifications never use the window.
 */
export function findSamsungPromotedRefreshAccount(
  db: D1Database,
  proof: SamsungPromotedRefreshProof,
  now: number,
): Promise<AccountRow | null> {
  return first(
    db,
    `WITH clock(now_ms) AS (SELECT ?)
    SELECT a.id, a.org_id, a.mode, a.provider, ${REVISION_EXPR} AS revision, a.credential_id,
      a.credential_source_id, a.revoked_at, a.updated_at, a.authority_epoch, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext, ${OWN_KEY}
    FROM wallet_provider_accounts a LEFT JOIN wallet_provider_credentials c
      ON c.id = a.credential_id AND c.account_id = a.id AND c.org_id = a.org_id
      AND c.mode = a.mode AND c.provider = a.provider
    JOIN wallet_provider_instances i ON i.account_id = a.id AND i.org_id = a.org_id
      AND i.mode = a.mode AND i.provider = a.provider
    JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id AND op.instance_id = i.id
    JOIN wallet_samsung_fetch_refs r ON r.instance_id = i.id AND r.ref_hash = ?
      AND ${proof.window ? samsungInitialWindowSql : 'r.promoted_at IS NOT NULL'} AND r.retired_at IS NULL
      AND r.credential_keyset_commitment = i.credential_keyset_commitment
    CROSS JOIN clock
    WHERE a.org_id = ? AND a.mode = ? AND a.provider = 'samsung' AND a.id = ? AND ${pinExpr(proof)} = ?
      AND ${OPENABLE} AND a.revoked_at IS NULL AND i.id = ? AND i.lifecycle = 'active'
      AND op.kind = 'upsert' AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
      AND op.version = ? AND op.projection_release_id = ?
      AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = op.credential_keyset_commitment
      AND ${walletInstanceOperationCurrentSql('i', 'op', 'clock.now_ms', undefined, proof.authorityEpoch !== undefined)}`,
    [
      now,
      proof.refHash,
      ...(proof.window ? [now, now] : []),
      proof.orgId,
      proof.mode,
      proof.accountId,
      proof.authorityEpoch ?? proof.accountRevision,
      proof.instanceId,
      proof.operationVersion,
      proof.projectionReleaseId,
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
  },
): Promise<
  | (AccountRow & {
      provider_identity_hash: string;
      pin_version_id: string | null;
      card_type: string | null;
    })
  | null
> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, t.account_revision AS revision,
      e.credential_id, NULL AS credential_source_id, NULL AS revoked_at,
      e.created_at AS updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext,
      t.provider_identity_hash, t.credential_version_id AS pin_version_id,
      COALESCE(json_extract(candidate.projection_json, '$.cardType'), json_extract(candidate.projection_json, '$.type')) AS card_type
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
      AND t.credential_keyset_commitment = ${pinnedKeysetSql}
      AND json_extract(candidate.projection_json, '$.schema') = 2`,
    [input.refHash, input.orgId, input.mode, input.accountId, input.accountRevision],
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
