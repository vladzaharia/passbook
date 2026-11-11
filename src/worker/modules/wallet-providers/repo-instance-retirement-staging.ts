import { batch, run, type SqlValue, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { WalletCredentialKeysetProof, WalletOperationRef } from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import {
  desiredOperationKeysetSql,
  retirementProjectionSql,
  walletNoProviderArtifactsSql,
} from './repo-instance-retirement-sql.ts';

interface WalletRetirementPassFence extends WalletCredentialKeysetProof {
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  passVersion: number;
  passRevision: number;
  lifecycleGeneration: number;
  passCredentialGeneration: number;
  issuingReleaseId: string | null;
  now: number;
}

/** A caller's trusted SQL guard may reference pass alias p and instance alias i. */
export function walletRetirementIntentStatements(
  db: D1Database,
  p: WalletRetirementPassFence,
  guard: { sql: string; params: readonly SqlValue[] },
): D1PreparedStatement[] {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment))
    throw new Error('Invalid credential keyset commitment.');
  const current = `p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
    AND p.id = ? AND p.org_id = ? AND p.mode = ? AND p.version = ? AND p.revision = ?
    AND p.lifecycle_generation = ? AND p.credential_generation = ? AND p.release_id IS ?
    AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql} AND (${guard.sql})`;
  const values: SqlValue[] = [
    p.passId,
    p.orgId,
    p.mode,
    p.passVersion,
    p.passRevision,
    p.lifecycleGeneration,
    p.passCredentialGeneration,
    p.issuingReleaseId,
    p.credentialKeysetCommitment,
    p.credentialKeysetCommitment,
    ...guard.params,
  ];
  return [
    stmt(
      db,
      `UPDATE wallet_provider_instances AS i SET lifecycle = 'retired',
        retirement_reason = 'not_issued', retired_at = ?, updated_at = ?
      WHERE i.lifecycle IN ('blocked', 'ready') AND ${walletNoProviderArtifactsSql('i')}
        AND EXISTS (SELECT 1 FROM passes p WHERE ${current})`,
      [p.now, p.now, ...values],
    ),
    stmt(
      db,
      `INSERT INTO wallet_provider_instance_dirty(instance_id, generation, next_attempt_at)
      SELECT i.id, 1, 0 FROM wallet_provider_instances i
      WHERE i.lifecycle IN ('active', 'revoking', 'revoked') AND i.retirement_requested_at IS NULL
        AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
          AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
        AND ${desiredOperationKeysetSql('i')} AND ${retirementProjectionSql('i')}
        AND EXISTS (SELECT 1 FROM passes p WHERE ${current})
      ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0`,
      values,
    ),
    stmt(
      db,
      `UPDATE wallet_provider_instances AS i
      SET retirement_requested_at = ?, updated_at = ?
      WHERE i.lifecycle IN ('active', 'revoking', 'revoked') AND i.retirement_requested_at IS NULL
        AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
          AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
        AND ${desiredOperationKeysetSql('i')} AND ${retirementProjectionSql('i')}
        AND EXISTS (SELECT 1 FROM passes p WHERE ${current})`,
      [p.now, p.now, ...values],
    ),
  ];
}

/** The dirty marker survives a crash between requesting retirement and queuing its revoke. */
export async function requestRetirement(
  db: D1Database,
  p: WalletOperationRef &
    WalletCredentialKeysetProof & {
      now: number;
      passVersion: number;
      passRevision: number;
      lifecycleGeneration: number;
      passCredentialGeneration: number;
      issuingReleaseId: string | null;
    },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE wallet_provider_instances AS i SET retirement_requested_at = COALESCE(retirement_requested_at, ?),
        updated_at = ? WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ?
        AND i.desired_version = ? AND i.lifecycle IN ('active', 'revoking', 'revoked')
        AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
        AND ${desiredOperationKeysetSql('i')} AND ${retirementProjectionSql('i')}
        AND EXISTS (SELECT 1 FROM passes p WHERE p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
          AND p.version = ? AND p.revision = ? AND p.lifecycle_generation = ?
          AND p.credential_generation = ? AND p.release_id IS ?)`,
      [
        p.now,
        p.now,
        p.instanceId,
        p.orgId,
        p.mode,
        p.provider,
        p.version,
        p.credentialKeysetCommitment,
        p.credentialKeysetCommitment,
        p.passVersion,
        p.passRevision,
        p.lifecycleGeneration,
        p.passCredentialGeneration,
        p.issuingReleaseId,
      ],
    ),
    stmt(
      db,
      `INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
      SELECT id, 1 FROM wallet_provider_instances WHERE id = ? AND org_id = ? AND mode = ? AND provider = ?
        AND desired_version = ? AND retirement_requested_at IS NOT NULL AND changes() = 1
        AND credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0`,
      [
        p.instanceId,
        p.orgId,
        p.mode,
        p.provider,
        p.version,
        p.credentialKeysetCommitment,
        p.credentialKeysetCommitment,
      ],
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

/** Close only a superseded or deleted, provably never-issued generation. */
export async function retireUnissuedPlaceholder(
  db: D1Database,
  p: WalletCredentialKeysetProof & {
    instanceId: string;
    orgId: string;
    mode: 'live' | 'test';
    provider: 'google' | 'samsung';
    credentialGeneration: number;
    passCredentialGeneration: number;
    now: number;
  },
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const result = await run(
    db,
    `UPDATE wallet_provider_instances AS i
    SET lifecycle = 'retired', retirement_reason = 'not_issued', retired_at = ?, updated_at = ?
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.credential_generation = ?
      AND i.lifecycle IN ('blocked', 'ready') AND ${walletNoProviderArtifactsSql('i')}
      AND i.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND EXISTS (SELECT 1 FROM passes p WHERE p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
        AND p.credential_generation = ? AND (p.deleted_at IS NOT NULL OR i.retirement_requested_at IS NOT NULL
          OR p.credential_generation > i.credential_generation
          OR EXISTS (SELECT 1 FROM pass_credential_transfers t
            WHERE t.pass_id = p.id AND t.state = 'pending' AND t.target_generation > i.credential_generation)))`,
    [
      p.now,
      p.now,
      p.instanceId,
      p.orgId,
      p.mode,
      p.provider,
      p.credentialGeneration,
      p.credentialKeysetCommitment,
      p.credentialKeysetCommitment,
      p.passCredentialGeneration,
    ],
  );
  return result.changes === 1;
}
