import { run } from '../../platform/db.ts';

interface SamsungRetirementFixture {
  operationId: string;
  instanceId: string;
  version: number;
  requestHash: string;
  snapshot: {
    passVersion: number;
    passRevision: number;
    lifecycleGeneration: number;
    issuingReleaseId: string | null;
  };
  credentialGeneration: number;
  scope: {
    providerReleaseId: string;
    accountRevision: number;
    credentialKeysetCommitment: string;
  };
  policy: { adapterRevision: number; audiencePolicyRevision: number };
  claimHash: string;
  now: number;
}

export async function seedSamsungRetirementOperation(
  db: D1Database,
  input: SamsungRetirementFixture,
): Promise<void> {
  const { operationId, instanceId, version, requestHash, snapshot, scope, policy, claimHash, now } =
    input;
  await run(
    db,
    `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
       credential_keyset_commitment, state, attempts, claim_hash, claim_expires_at, created_at)
      VALUES (?, ?, ?, 'revoke', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
    [
      operationId,
      instanceId,
      version,
      requestHash,
      snapshot.passVersion,
      snapshot.passRevision,
      input.credentialGeneration,
      snapshot.lifecycleGeneration,
      snapshot.issuingReleaseId,
      scope.providerReleaseId,
      scope.accountRevision,
      policy.adapterRevision,
      policy.audiencePolicyRevision,
      scope.credentialKeysetCommitment,
      claimHash,
      now + 120_000,
      now,
    ],
  );
  await run(
    db,
    `UPDATE wallet_provider_instances SET desired_version = ?, desired_operation_id = ?,
      lifecycle = 'revoking' WHERE id = ?`,
    [version, operationId, instanceId],
  );
}
