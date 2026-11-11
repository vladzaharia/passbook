import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';

export interface HistoricalSamsungRef {
  id: string;
  refHash: string;
  instanceId: string;
  /** Original commitment captured with this reference; never backfill from the D1 singleton. */
  credentialKeysetCommitment: string;
  createdAt: number;
  lastOfferedAt?: number;
  initialExpiresAt: number;
  promotedAt: number | null;
  retiredAt?: number | null;
  envelope: Envelope;
}

export interface HistoricalProviderInstance {
  id: string;
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  provider: 'google' | 'samsung';
  credentialGeneration: number;
  /** Original commitment captured for this authority; never backfill from the current D1 singleton. */
  credentialKeysetCommitment: string;
  accountId: string;
  releaseId: string;
  operationId: string;
  now: number;
  retirementRequestedAt?: number | null;
  /** Optional pre-existing upsert; absent when the caller seeds its own historical operation. */
  upsert?: { requestHash: string; state: 'pending' | 'succeeded' };
}

export async function insertHistoricalProviderInstance(
  db: D1Database,
  input: HistoricalProviderInstance,
): Promise<void> {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wallet_provider_generation_insert_guard'",
  );
  if (!trigger?.sql) throw new Error('Missing provider generation guard');
  const statements = [
    stmt(db, 'DROP TRIGGER wallet_provider_generation_insert_guard'),
    stmt(
      db,
      `INSERT INTO wallet_provider_instances
      (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id, credential_generation,
       credential_keyset_commitment, lifecycle, desired_version, desired_operation_id, retirement_requested_at, created_at, updated_at)
      SELECT ?, p.id, p.org_id, p.mode, a.provider, a.id, r.id, p.credential_generation,
        ?, 'active', 1, ?, ?, ?, ?
      FROM passes p JOIN wallet_provider_accounts a ON a.id = ? AND a.org_id = p.org_id
        AND a.mode = p.mode AND a.provider = ? AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL
      JOIN template_releases r ON r.id = ? AND r.org_id = p.org_id AND r.mode = p.mode
        AND r.provider = a.provider AND r.template_id = p.template_id AND r.version = p.template_version
        AND r.source = 'approved'
      JOIN template_candidates c ON c.id = r.candidate_id AND c.source_release_id = p.release_id
        AND c.provider_account_id = a.id AND c.provider_account_revision = a.revision
        AND c.candidate_hash = r.candidate_hash
      JOIN template_approvals approval ON approval.id = r.approval_id AND approval.candidate_id = c.id
        AND approval.candidate_hash = c.candidate_hash AND approval.reviewer_id != c.author_id
        AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id)
      WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.credential_generation = ?`,
      [
        input.id,
        input.credentialKeysetCommitment,
        input.operationId,
        input.retirementRequestedAt ?? null,
        input.now,
        input.now,
        input.accountId,
        input.provider,
        input.releaseId,
        input.passId,
        input.orgId,
        input.mode,
        input.credentialGeneration,
      ],
    ),
    stmt(db, trigger.sql),
  ];
  if (input.upsert)
    statements.splice(
      2,
      0,
      stmt(
        db,
        `INSERT INTO wallet_provider_instance_operations
    (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
     lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
     policy_revision, credential_keyset_commitment, state, attempts, created_at)
    SELECT ?, i.id, 1, 'upsert', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
      p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision, ?, ?, ?, ?
    FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
      JOIN wallet_provider_accounts a ON a.id = i.account_id
      JOIN template_releases r ON r.id = i.identity_projection_release_id
    WHERE i.id = ? AND i.desired_operation_id = ? AND i.desired_version = 1 AND p.release_id IS NOT NULL`,
        [
          input.operationId,
          input.upsert.requestHash,
          input.credentialKeysetCommitment,
          input.upsert.state,
          input.upsert.state === 'succeeded' ? 1 : 0,
          input.now,
          input.id,
          input.operationId,
        ],
      ),
    );
  const result = await batch(db, statements);
  if (result[1]?.meta.changes !== 1 || (input.upsert && result[2]?.meta.changes !== 1))
    throw new Error('Missing reviewed historical provider instance');
}

async function insertHistoricalArtifact(
  db: D1Database,
  guard: 'wallet_provider_generation_samsung_ref' | 'wallet_provider_generation_offer_insert',
  statement: D1PreparedStatement,
) {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    [guard],
  );
  if (!trigger?.sql) throw new Error('Missing provider artifact guard');
  const result = await batch(db, [
    stmt(db, `DROP TRIGGER ${guard}`),
    statement,
    stmt(db, trigger.sql),
  ]);
  if (result[1]?.meta.changes !== 1) throw new Error('Missing historical provider artifact');
}

export async function insertHistoricalSamsungRef(
  db: D1Database,
  input: HistoricalSamsungRef,
): Promise<void> {
  const envelope = input.envelope;
  await insertHistoricalArtifact(
    db,
    'wallet_provider_generation_samsung_ref',
    stmt(
      db,
      `INSERT INTO wallet_samsung_fetch_refs
    (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at, promoted_at, retired_at,
     credential_keyset_commitment, kek_version, iv, wrapped_dek, ciphertext)
    SELECT ?, ?, i.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM wallet_provider_instances i
    WHERE i.id = ? AND i.provider = 'samsung' AND i.account_id IS NOT NULL`,
      [
        input.id,
        input.refHash,
        input.createdAt,
        input.lastOfferedAt ?? input.createdAt,
        input.initialExpiresAt,
        input.promotedAt,
        input.retiredAt ?? null,
        input.credentialKeysetCommitment,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        input.instanceId,
      ],
    ),
  );
}

/**
 * Restore a pre-existing wrapper without authorizing an offer or its consumption.
 * The wrapper has no commitment column; its original operation carries the proof.
 */
export async function seedHistoricalOfferRef(
  db: D1Database,
  input: {
    refHash: string;
    instanceId: string;
    operationVersion: number;
    createdAt: number;
    expiresAt: number;
    consumedAt: number | null;
    deliveredAt: number | null;
  },
) {
  await insertHistoricalArtifact(
    db,
    'wallet_provider_generation_offer_insert',
    stmt(
      db,
      `INSERT INTO wallet_provider_offer_refs
    (ref_hash, instance_id, operation_version, pass_authority_generation, created_at, expires_at, consumed_at, delivered_at)
    SELECT ?, i.id, op.version, COALESCE(authority.generation, 0), ?, ?, ?, ?
    FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op
      ON op.instance_id = i.id AND op.version = ?
    LEFT JOIN wallet_provider_pass_authority authority ON authority.pass_id = i.pass_id
    WHERE i.id = ? AND i.account_id IS NOT NULL`,
      [
        input.refHash,
        input.createdAt,
        input.expiresAt,
        input.consumedAt,
        input.deliveredAt,
        input.operationVersion,
        input.instanceId,
      ],
    ),
  );
}
