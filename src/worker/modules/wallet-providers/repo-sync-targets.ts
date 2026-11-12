import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { walletClaimHash } from './instance-claims.ts';
import type { WalletClaimRef, WalletReasonCode } from './instance-types.ts';

export interface SamsungSyncTarget {
  countryCode: string;
  state: 'pending' | 'inflight' | 'retry' | 'succeeded' | 'failed' | 'uncertain';
  attempts: number;
  nextAttemptAt: number | null;
  reasonCode: WalletReasonCode | null;
  httpStatus: number | null;
}
/** Distinct untrusted fixed-host routing hints, used to version a Samsung reconciliation intent. */
export async function samsungSyncCountryHints(
  ctx: ServiceContext,
  instance: {
    instanceId: string;
    orgId: string;
    mode: 'live' | 'test';
    credentialKeysetCommitment: string;
  },
): Promise<string[]> {
  const rows = await all<{ countryCode: string }>(
    ctx.env.DB,
    `SELECT DISTINCT h.country_code AS countryCode
    FROM wallet_provider_instances i
    JOIN wallet_provider_instance_operations o ON o.id = i.desired_operation_id
      AND o.instance_id = i.id AND o.version = i.desired_version
      AND o.credential_keyset_commitment = i.credential_keyset_commitment
    JOIN wallet_samsung_fetch_refs r ON r.instance_id = i.id
    JOIN wallet_samsung_country_hints h ON h.ref_id = r.id
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
      AND i.credential_keyset_commitment = ? AND r.credential_keyset_commitment = i.credential_keyset_commitment
      AND ${credentialRefKeysetSql}
      AND r.promoted_at IS NOT NULL ORDER BY h.country_code`,
    [
      instance.instanceId,
      instance.orgId,
      instance.mode,
      instance.credentialKeysetCommitment,
      instance.credentialKeysetCommitment,
    ],
  );
  return rows.map((row) => row.countryCode);
}

/**
 * Take only country hints previously received for this instance's promoted Samsung reference.
 * A country is an untrusted routing hint, not installation evidence. The claim and the desired
 * operation must still match when the rows are inserted; the hint never selects an arbitrary host.
 */
export async function ensureSamsungSyncTargets(
  ctx: ServiceContext,
  claim: WalletClaimRef,
): Promise<void> {
  const hash = await walletClaimHash(claim.claimHandle);
  await run(
    ctx.env.DB,
    `INSERT INTO wallet_provider_sync_targets
      (operation_id, country_code, state, attempts, updated_at)
    SELECT DISTINCT o.id, h.country_code, 'pending', 0, ?
    FROM wallet_provider_instances i
    JOIN wallet_provider_instance_operations o ON o.id = i.desired_operation_id
      AND o.instance_id = i.id AND o.version = i.desired_version
    JOIN wallet_samsung_fetch_refs r ON r.instance_id = i.id
      AND r.credential_keyset_commitment = i.credential_keyset_commitment
      AND r.promoted_at IS NOT NULL AND (o.kind = 'revoke' OR r.retired_at IS NULL)
    JOIN wallet_samsung_country_hints h ON h.ref_id = r.id
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
      AND ? = 'samsung' AND o.version = ? AND o.state = 'claimed'
      AND o.claim_hash = ? AND o.claim_expires_at > ?
      AND i.credential_keyset_commitment = ? AND o.credential_keyset_commitment = i.credential_keyset_commitment
      AND ${credentialRefKeysetSql}
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations previous
        JOIN wallet_provider_sync_targets delivered ON delivered.operation_id = previous.id
          AND delivered.country_code = h.country_code AND delivered.state = 'succeeded'
        WHERE previous.instance_id = i.id AND previous.version < o.version AND previous.kind = o.kind
          AND previous.credential_keyset_commitment = o.credential_keyset_commitment
          AND previous.pass_version = o.pass_version AND previous.pass_revision = o.pass_revision
          AND previous.lifecycle_generation = o.lifecycle_generation
          AND previous.pass_credential_generation = o.pass_credential_generation
          AND previous.issuing_release_id IS o.issuing_release_id
          AND previous.projection_release_id = o.projection_release_id
          AND previous.account_revision = o.account_revision
          AND previous.adapter_revision = o.adapter_revision AND previous.policy_revision = o.policy_revision)
    ON CONFLICT(operation_id, country_code) DO NOTHING`,
    [
      claim.now,
      claim.instanceId,
      claim.orgId,
      claim.mode,
      claim.provider,
      claim.version,
      hash,
      claim.now,
      claim.credentialKeysetCommitment,
      claim.credentialKeysetCommitment,
    ],
  );
}

/** Only the claim holder can enumerate outcomes, including successes from earlier attempts. */
export async function listSamsungSyncTargets(
  ctx: ServiceContext,
  claim: WalletClaimRef,
): Promise<SamsungSyncTarget[]> {
  const hash = await walletClaimHash(claim.claimHandle);
  return all<SamsungSyncTarget>(
    ctx.env.DB,
    `SELECT t.country_code AS countryCode, t.state,
      t.attempts, t.next_attempt_at AS nextAttemptAt, t.reason_code AS reasonCode,
      t.http_status AS httpStatus
    FROM wallet_provider_sync_targets t
    JOIN wallet_provider_instance_operations o ON o.id = t.operation_id
    JOIN wallet_provider_instances i ON i.id = o.instance_id
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
      AND ? = 'samsung' AND o.version = ? AND o.state IN ('claimed', 'uncertain')
      AND o.claim_hash = ? AND i.credential_keyset_commitment = ?
      AND o.credential_keyset_commitment = i.credential_keyset_commitment
      AND ${credentialRefKeysetSql} ORDER BY t.country_code`,
    [
      claim.instanceId,
      claim.orgId,
      claim.mode,
      claim.provider,
      claim.version,
      hash,
      claim.credentialKeysetCommitment,
      claim.credentialKeysetCommitment,
    ],
  );
}

/** Mark a single due target in-flight before sending, under the exact current, unexpired claim. */
export async function beginSamsungSyncTarget(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  countryCode: string,
): Promise<number | null> {
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  const hash = await walletClaimHash(claim.claimHandle);
  const now = ctx.clock.now();
  const row = await first<{ attempts: number }>(
    ctx.env.DB,
    `UPDATE wallet_provider_sync_targets AS t
    SET state = 'inflight', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
    WHERE t.country_code = ? AND t.state IN ('pending', 'retry') AND t.attempts < 3
      AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations o
        JOIN wallet_provider_instances i ON i.id = o.instance_id
        WHERE o.id = t.operation_id AND i.id = ? AND i.org_id = ? AND i.mode = ?
          AND i.provider = 'samsung' AND ? = 'samsung' AND o.version = ?
          AND i.desired_version = o.version AND i.desired_operation_id = o.id
          AND o.state = 'claimed' AND o.claim_hash = ? AND o.claim_expires_at > ?
          AND i.credential_keyset_commitment = ? AND o.credential_keyset_commitment = i.credential_keyset_commitment
          AND ${credentialRefKeysetSql})
    RETURNING attempts`,
    [
      now,
      countryCode,
      now,
      claim.instanceId,
      claim.orgId,
      claim.mode,
      claim.provider,
      claim.version,
      hash,
      now,
      claim.credentialKeysetCommitment,
      claim.credentialKeysetCommitment,
    ],
  );
  return row?.attempts ?? null;
}

export type SamsungTargetOutcome =
  | { kind: 'success'; status?: number }
  | {
      kind: 'failure';
      reason: Exclude<WalletReasonCode, 'ok'>;
      retryAt: number | null;
      status?: number;
    }
  | { kind: 'uncertain'; reason: Exclude<WalletReasonCode, 'ok'>; status?: number };

/**
 * A response may arrive after revocation was queued or the lease expired. Record the actual
 * settled result against the same claim even when it is no longer desired; the encompassing
 * operation remains serialized until its owner settles the old claim.
 */
export async function finishSamsungSyncTarget(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  countryCode: string,
  outcome: SamsungTargetOutcome,
): Promise<boolean> {
  if (!/^[A-Z]{2}$/.test(countryCode)) return false;
  const hash = await walletClaimHash(claim.claimHandle);
  const state =
    outcome.kind === 'success'
      ? 'succeeded'
      : outcome.kind === 'uncertain'
        ? 'uncertain'
        : outcome.retryAt === null
          ? 'failed'
          : 'retry';
  const reason = outcome.kind === 'success' ? 'ok' : outcome.reason;
  const retryAt = outcome.kind === 'failure' ? outcome.retryAt : null;
  const status = outcome.status;
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
    return false;
  const result = await run(
    ctx.env.DB,
    `UPDATE wallet_provider_sync_targets AS t
    SET state = ?, reason_code = ?, http_status = ?, next_attempt_at = ?, updated_at = ?
    WHERE t.country_code = ? AND t.state = 'inflight'
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations o
        JOIN wallet_provider_instances i ON i.id = o.instance_id
        WHERE o.id = t.operation_id AND i.id = ? AND i.org_id = ? AND i.mode = ?
          AND i.provider = 'samsung' AND ? = 'samsung' AND o.version = ?
          AND o.state IN ('claimed', 'uncertain') AND o.claim_hash = ?
          AND i.credential_keyset_commitment = ? AND o.credential_keyset_commitment = i.credential_keyset_commitment
          AND ${credentialRefKeysetSql})`,
    [
      state,
      reason,
      status ?? null,
      retryAt,
      ctx.clock.now(),
      countryCode,
      claim.instanceId,
      claim.orgId,
      claim.mode,
      claim.provider,
      claim.version,
      hash,
      claim.credentialKeysetCommitment,
      claim.credentialKeysetCommitment,
    ],
  );
  return result.changes === 1;
}
