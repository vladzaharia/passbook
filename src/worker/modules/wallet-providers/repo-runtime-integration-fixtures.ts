import { batch, first, run, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';

export function readHistoricalCredentialGeneration(db: D1Database, passId: string) {
  return first<{ credentialGeneration: number }>(
    db,
    'SELECT credential_generation AS credentialGeneration FROM passes WHERE id = ?',
    [passId],
  );
}

export function readHistoricalGoogleReleaseGuard(db: D1Database) {
  return first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'template_provider_releases_insert'",
  );
}

export function insertHistoricalGoogleRelease(
  db: D1Database,
  input: {
    triggerSql: string;
    releaseId: string;
    now: number;
    candidateId: string;
    approvalId: string;
    credentialKeysetCommitment: string;
  },
) {
  return batch(db, [
    stmt(db, 'DROP TRIGGER template_provider_releases_insert'),
    stmt(
      db,
      `INSERT INTO template_releases
      (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
       adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
       approval_id, previous_release_id, rollback_of_release_id, created_by, created_at, credential_keyset_commitment)
      SELECT ?, c.template_id, c.org_id, c.mode, c.provider, 1, c.version, c.candidate_hash, c.content_hash,
        c.adapter_revision, c.adapter_capabilities, c.audience_policy_revision, 'approved', 'release',
        c.id, a.id, NULL, NULL, c.author_id, ?, c.credential_keyset_commitment
      FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
        AND a.candidate_hash = c.candidate_hash AND a.credential_keyset_commitment = c.credential_keyset_commitment
      WHERE c.id = ? AND a.id = ? AND c.provider = 'google' AND a.reviewer_id != c.author_id
        AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)
        AND c.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}`,
      [
        input.releaseId,
        input.now,
        input.candidateId,
        input.approvalId,
        input.credentialKeysetCommitment,
        input.credentialKeysetCommitment,
      ],
    ),
    stmt(db, input.triggerSql),
  ]);
}

export function readHistoricalGoogleAccount(db: D1Database, orgId: string, mode: 'live' | 'test') {
  return first<{ id: string; revision: number }>(
    db,
    "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = 'google'",
    [orgId, mode],
  );
}

export function insertHistoricalGoogleRevoke(
  db: D1Database,
  input: {
    operationId: string;
    instanceId: string;
    requestHash: string;
    passVersion: number;
    passRevision: number;
    credentialGeneration: number;
    lifecycleGeneration: number;
    issuingReleaseId: string;
    releaseId: string;
    accountRevision: number;
    adapterRevision: number;
    policyRevision: number;
    credentialKeysetCommitment: string;
    claimHash: string;
    now: number;
  },
) {
  return run(
    db,
    `INSERT INTO wallet_provider_instance_operations
    (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
     lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
     credential_keyset_commitment, state, attempts, claim_hash, claim_expires_at, created_at)
    VALUES (?, ?, 1, 'revoke', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
    [
      input.operationId,
      input.instanceId,
      input.requestHash,
      input.passVersion,
      input.passRevision,
      input.credentialGeneration,
      input.lifecycleGeneration,
      input.issuingReleaseId,
      input.releaseId,
      input.accountRevision,
      input.adapterRevision,
      input.policyRevision,
      input.credentialKeysetCommitment,
      input.claimHash,
      input.now + 120_000,
      input.now,
    ],
  );
}

export function markHistoricalGoogleRevoking(db: D1Database, instanceId: string) {
  return run(db, "UPDATE wallet_provider_instances SET lifecycle = 'revoking' WHERE id = ?", [
    instanceId,
  ]);
}
