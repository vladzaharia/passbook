import { first, run } from '../../platform/db.ts';
import type { Pass } from './repo-map.ts';
import {
  type RemovalGuard,
  type RemovalInput,
  type RemovalState,
  snapshotParams,
  snapshotSql,
} from './repo-remove-snapshot.ts';

// Raw writes, allowlisted in tools/authority-scope.ts: the claims for trusted callers that hold no tenant
// authority (fixtures, service tests; every route passes authority and takes the grant in repo-remove.ts), and
// the exact-state compensation of this request's own claim, which must run even after the authority was revoked.

/** Claims a new removal and records the exact pre-publication pass snapshot. */
export async function claimRemovalTrusted(
  db: D1Database,
  passId: string,
  state: RemovalInput,
  guard: RemovalGuard,
): Promise<number | null> {
  if (guard.pass.removedAt !== null) return null;
  const row = await first<{ generation: number }>(
    db,
    `UPDATE passes SET removed_at = ?, removal_message = ?, removal_prior_status = ?,
       lifecycle_generation = lifecycle_generation + 1, removal_claim_version = version,
       removal_claim_status = status, removal_claim_object_key = object_key,
       removal_claim_link_generation = link_generation
     WHERE id = ? AND removed_at IS NULL AND ${snapshotSql} AND lifecycle_generation = ?
     RETURNING lifecycle_generation AS generation`,
    [
      state.at,
      state.message,
      state.priorStatus,
      passId,
      ...snapshotParams(guard.pass),
      guard.generation,
    ],
  );
  return row?.generation ?? null;
}

/** Compensate only the exact staged removal, even if the request's authority was revoked. */
export async function releaseRemoval(
  db: D1Database,
  passId: string,
  staged: { pass: Pass; state: RemovalInput; generation: number },
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET removed_at = NULL, removal_message = NULL, removal_prior_status = NULL,
       lifecycle_generation = lifecycle_generation + 1, removal_published_generation = NULL,
       removal_claim_version = NULL, removal_claim_status = NULL, removal_claim_object_key = NULL,
       removal_claim_link_generation = NULL
     WHERE id = ? AND removed_at = ? AND removal_message IS ? AND removal_prior_status IS ?
       AND lifecycle_generation = ? AND removal_claim_version = ? AND removal_claim_status = ?
       AND removal_claim_object_key = ? AND removal_claim_link_generation = ? AND ${snapshotSql}`,
    [
      passId,
      staged.state.at,
      staged.state.message,
      staged.state.priorStatus,
      staged.generation,
      staged.pass.version,
      staged.pass.status,
      staged.pass.objectKey,
      staged.pass.linkGeneration,
      ...snapshotParams(staged.pass),
    ],
  );
}

/** Claims the exact removal and advances the generation even when all other fields repeat. */
export async function claimRestoreTrusted(
  db: D1Database,
  passId: string,
  state: RemovalState,
  guard: RemovalGuard,
): Promise<number | null> {
  if (guard.pass.removedAt !== state.at || guard.generation !== state.generation) return null;
  const row = await first<{ generation: number }>(
    db,
    `UPDATE passes SET removed_at = NULL, removal_message = NULL, removal_prior_status = NULL,
       lifecycle_generation = lifecycle_generation + 1
     WHERE id = ? AND removed_at = ? AND removal_message IS ? AND removal_prior_status IS ?
       AND removal_published_generation IS ? AND removal_claim_version IS ?
       AND removal_claim_status IS ? AND removal_claim_object_key IS ?
       AND removal_claim_link_generation IS ?
       AND ${snapshotSql} AND lifecycle_generation = ? RETURNING lifecycle_generation AS generation`,
    [
      passId,
      state.at,
      state.message,
      state.rawPriorStatus,
      state.publishedGeneration,
      state.claimVersion,
      state.claimStatus,
      state.claimObjectKey,
      state.claimLinkGeneration,
      ...snapshotParams(guard.pass),
      guard.generation,
    ],
  );
  return row?.generation ?? null;
}

/** Restore a failed claim only while its exact pass and lifecycle generation still match. */
export async function reinstateRemoval(
  db: D1Database,
  passId: string,
  state: RemovalState,
  staged: { pass: Pass; generation: number },
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET removed_at = ?, removal_message = ?, removal_prior_status = ?,
       lifecycle_generation = lifecycle_generation + 1,
       removal_published_generation = NULL,
       removal_claim_version = ?, removal_claim_status = ?, removal_claim_object_key = ?,
       removal_claim_link_generation = ?
     WHERE id = ? AND removed_at IS NULL AND removal_message IS NULL
       AND removal_prior_status IS NULL AND lifecycle_generation = ?
       AND removal_published_generation IS ? AND removal_claim_version IS ?
       AND removal_claim_status IS ? AND removal_claim_object_key IS ?
       AND removal_claim_link_generation IS ? AND ${snapshotSql}`,
    [
      state.at,
      state.message,
      state.rawPriorStatus,
      staged.pass.version,
      staged.pass.status,
      staged.pass.objectKey,
      staged.pass.linkGeneration,
      passId,
      staged.generation,
      state.publishedGeneration,
      state.claimVersion,
      state.claimStatus,
      state.claimObjectKey,
      state.claimLinkGeneration,
      ...snapshotParams(staged.pass),
    ],
  );
}
