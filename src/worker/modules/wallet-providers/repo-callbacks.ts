import type { Mode } from '../../../shared/contracts/common.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, batch, first, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';

export interface SamsungOperationScope {
  orgId: string;
  mode: Mode;
  instanceId: string;
  operationVersion: number;
  credentialKeysetCommitment: string;
}

type BlobValue = number[] | Uint8Array | ArrayBuffer;
export interface SamsungRefEnvelope {
  id: string;
  instance_id: string;
  ref_hash: string;
  promoted_at: number | null;
  initial_expires_at: number;
  kek_version: number;
  iv: BlobValue;
  wrapped_dek: BlobValue;
  ciphertext: BlobValue;
}

export interface SamsungFetchSnapshot extends SamsungOperationScope {
  referenceId: string;
  refHash: string;
  accountId: string;
  accountRevision: number;
  passId: string;
  passVersion: number;
  passRevision: number;
  credentialGeneration: number;
  passCredentialGeneration: number;
  templateId: string;
  templateVersion: string;
  issuingReleaseId: string;
  projectionReleaseId: string;
  instanceCreatedAt: number;
  promotedAt: number | null;
}

const upsert = `i.provider = 'samsung' AND i.lifecycle = 'active' AND op.kind = 'upsert'
  AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
    WHERE transfer.pass_id = i.pass_id AND transfer.state = 'pending')
  AND ${walletInstanceOperationCurrentSql('i', 'op', 'clock.now')}`;
const current = `${walletInstanceOperationCurrentSql('i', 'op', 'clock.now')}`;
/** Bind the original operation and instance proof to the canonical singleton. */
export const samsungOperationKeysetSql = `i.credential_keyset_commitment = ?
  AND op.credential_keyset_commitment = i.credential_keyset_commitment AND ${credentialRefKeysetSql}`;
const join = `JOIN wallet_provider_instances i ON i.id = r.instance_id
  JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    AND op.instance_id = i.id AND op.version = i.desired_version
  CROSS JOIN (SELECT ? AS now) clock`;

/** Before promotion, only a delivered wrapper in the current pass-authority epoch opens a window. */
export const samsungInitialWindowSql = `(r.promoted_at IS NOT NULL OR
  (r.initial_expires_at > ? AND EXISTS (
    SELECT 1 FROM wallet_provider_offer_refs offer
    WHERE offer.instance_id = i.id AND offer.operation_version = op.version
      AND offer.consumed_at IS NOT NULL AND offer.delivered_at IS NOT NULL AND offer.expires_at > ?
      AND offer.pass_authority_generation = COALESCE(
        (SELECT generation FROM wallet_provider_pass_authority authority WHERE authority.pass_id = i.pass_id), 0))))`;

/** Create or reopen the same pre-promotion ref only under the exact current operation. */
export async function putSamsungFetchRef(
  db: D1Database,
  scope: SamsungOperationScope,
  input: { id: string; hash: string; envelope: Envelope; now: number; expiresAt: number },
): Promise<SamsungRefEnvelope | null> {
  if (!walletProviderEnabled('samsung')) return null;
  const { now, expiresAt, envelope } = input;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 300_000
  )
    return null;
  const binding = [scope.instanceId, scope.orgId, scope.mode, scope.operationVersion] as const;
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_samsung_fetch_refs
      (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at,
       kek_version, iv, wrapped_dek, ciphertext, credential_keyset_commitment)
      SELECT ?, ?, i.id, ?, ?, ?, ?, ?, ?, ?, i.credential_keyset_commitment FROM wallet_provider_instances i
      JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
        AND op.instance_id = i.id AND op.version = i.desired_version
      CROSS JOIN (SELECT ? AS now) clock
      WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND op.version = ? AND ${upsert}
        AND ${samsungOperationKeysetSql}
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones tomb WHERE tomb.ref_hash = ?)
      ON CONFLICT DO NOTHING`,
      [
        input.id,
        input.hash,
        now,
        now,
        expiresAt,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        now,
        ...binding,
        scope.credentialKeysetCommitment,
        scope.credentialKeysetCommitment,
        input.hash,
      ],
    ),
    stmt(
      db,
      `UPDATE wallet_samsung_fetch_refs AS r SET
        last_offered_at = CASE WHEN promoted_at IS NULL THEN MAX(last_offered_at, ?) ELSE last_offered_at END,
        initial_expires_at = CASE WHEN promoted_at IS NULL THEN MAX(initial_expires_at, ?) ELSE initial_expires_at END
      WHERE r.instance_id = ? AND r.retired_at IS NULL AND EXISTS (
        SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op
          ON op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
        CROSS JOIN (SELECT ? AS now) clock
        WHERE i.id = r.instance_id AND i.org_id = ? AND i.mode = ? AND op.version = ? AND ${upsert}
          AND r.credential_keyset_commitment = i.credential_keyset_commitment AND ${samsungOperationKeysetSql})`,
      [
        now,
        expiresAt,
        scope.instanceId,
        now,
        scope.orgId,
        scope.mode,
        scope.operationVersion,
        scope.credentialKeysetCommitment,
        scope.credentialKeysetCommitment,
      ],
    ),
    stmt(
      db,
      `SELECT r.* FROM wallet_samsung_fetch_refs r ${join}
      WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND op.version = ?
        AND r.retired_at IS NULL AND ${upsert}
        AND r.credential_keyset_commitment = i.credential_keyset_commitment AND ${samsungOperationKeysetSql}`,
      [now, ...binding, scope.credentialKeysetCommitment, scope.credentialKeysetCommitment],
    ),
  ]);
  return (results[2]?.results[0] as SamsungRefEnvelope | undefined) ?? null;
}

/** Lookup alone grants nothing; signature, replay reservation and final proof are still required. */
export function findSamsungFetchSnapshot(
  db: D1Database,
  hash: string,
  now: number,
  credentialKeysetCommitment: string,
  requirePromoted = false,
): Promise<SamsungFetchSnapshot | null> {
  return first<SamsungFetchSnapshot>(
    db,
    `SELECT r.id AS referenceId, r.ref_hash AS refHash,
      i.id AS instanceId, i.org_id AS orgId, i.mode, i.account_id AS accountId,
      op.account_revision AS accountRevision, op.version AS operationVersion,
      i.pass_id AS passId, op.pass_version AS passVersion, op.pass_revision AS passRevision,
      i.credential_generation AS credentialGeneration,
      op.pass_credential_generation AS passCredentialGeneration,
      p.template_id AS templateId, p.template_version AS templateVersion,
      op.issuing_release_id AS issuingReleaseId, op.projection_release_id AS projectionReleaseId,
      i.created_at AS instanceCreatedAt, r.promoted_at AS promotedAt,
      op.credential_keyset_commitment AS credentialKeysetCommitment
    FROM wallet_samsung_fetch_refs r ${join}
    JOIN passes p ON p.id = i.pass_id
    WHERE r.ref_hash = ? AND r.retired_at IS NULL
      AND ${requirePromoted ? 'r.promoted_at IS NOT NULL' : samsungInitialWindowSql}
      AND ${upsert} AND r.credential_keyset_commitment = i.credential_keyset_commitment
      AND ${samsungOperationKeysetSql}`,
    requirePromoted
      ? [now, hash, credentialKeysetCommitment, credentialKeysetCommitment]
      : [now, hash, now, now, credentialKeysetCommitment, credentialKeysetCommitment],
  );
}

/** Compare every captured operation component again at the actual promotion/response boundary. */
export function samsungSnapshotPredicate(): string {
  return `r.id = ? AND r.ref_hash = ? AND i.id = ? AND i.org_id = ? AND i.mode = ?
    AND i.account_id = ? AND op.account_revision = ? AND op.version = ?
    AND i.pass_id = ? AND op.pass_version = ? AND op.pass_revision = ?
    AND i.credential_generation = ? AND op.pass_credential_generation = ?
    AND p.credential_generation = op.pass_credential_generation
    AND p.template_id = ? AND p.template_version = ? AND op.issuing_release_id = ?
    AND op.projection_release_id = ? AND r.retired_at IS NULL AND ${upsert}
    AND r.credential_keyset_commitment = i.credential_keyset_commitment AND ${samsungOperationKeysetSql}`;
}

/** Metadata-only pass versions may reuse the latest earlier materialized pass JSON. */
export const samsungPassJsonCurrentSql = `(SELECT v.pass_json FROM pass_versions v
  WHERE v.pass_id = i.pass_id AND v.version <= op.pass_version ORDER BY v.version DESC LIMIT 1) = ?`;

export function samsungSnapshotParams(s: SamsungFetchSnapshot) {
  return [
    s.referenceId,
    s.refHash,
    s.instanceId,
    s.orgId,
    s.mode,
    s.accountId,
    s.accountRevision,
    s.operationVersion,
    s.passId,
    s.passVersion,
    s.passRevision,
    s.credentialGeneration,
    s.passCredentialGeneration,
    s.templateId,
    s.templateVersion,
    s.issuingReleaseId,
    s.projectionReleaseId,
    s.credentialKeysetCommitment,
    s.credentialKeysetCommitment,
  ] as const;
}

export async function samsungFetchSnapshotCurrent(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  rawPassJson: string,
  now: number,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM wallet_samsung_fetch_refs r ${join}
    JOIN passes p ON p.id = i.pass_id
    WHERE ${samsungSnapshotPredicate()} AND r.promoted_at IS NOT NULL
      AND ${samsungPassJsonCurrentSql}`,
    [now, ...samsungSnapshotParams(snapshot), rawPassJson],
  );
  return row !== null;
}

/** Recheck the exact persisted capability and current authority after decrypting it. */
export async function samsungRefStillCurrent(
  db: D1Database,
  scope: SamsungOperationScope,
  referenceId: string,
  forSync: boolean,
  now: number,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT r.id FROM wallet_samsung_fetch_refs r ${join}
    WHERE r.id = ? AND i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
      AND op.version = ? AND r.retired_at IS NULL
      AND ${forSync ? `r.promoted_at IS NOT NULL AND ${current}` : upsert}
      AND r.credential_keyset_commitment = i.credential_keyset_commitment AND ${samsungOperationKeysetSql}`,
    [
      now,
      referenceId,
      scope.instanceId,
      scope.orgId,
      scope.mode,
      scope.operationVersion,
      scope.credentialKeysetCommitment,
      scope.credentialKeysetCommitment,
    ],
  );
  return row !== null;
}

/** A revoke operation may recover a promoted ref for provider cleanup, not for card disclosure. */
export function getSamsungRefForSync(
  db: D1Database,
  scope: SamsungOperationScope,
  now: number,
): Promise<SamsungRefEnvelope | null> {
  return first<SamsungRefEnvelope>(
    db,
    `SELECT r.* FROM wallet_samsung_fetch_refs r ${join}
    WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung' AND op.version = ?
      AND r.promoted_at IS NOT NULL AND r.retired_at IS NULL AND ${current}
      AND r.credential_keyset_commitment = i.credential_keyset_commitment AND ${samsungOperationKeysetSql}`,
    [
      now,
      scope.instanceId,
      scope.orgId,
      scope.mode,
      scope.operationVersion,
      scope.credentialKeysetCommitment,
      scope.credentialKeysetCommitment,
    ],
  );
}

/** Untrusted hints are only suitable for fixed-domain notification paths. */
export async function listSamsungCountryHints(
  db: D1Database,
  referenceId: string,
): Promise<string[]> {
  const rows = await all<{ country_code: string }>(
    db,
    'SELECT country_code FROM wallet_samsung_country_hints WHERE ref_id = ? ORDER BY country_code',
    [referenceId],
  );
  return rows.map((row) => row.country_code);
}
