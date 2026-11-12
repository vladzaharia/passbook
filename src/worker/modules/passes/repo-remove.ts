import { grant } from '../../platform/authority.ts';
import { passRow, rowIs } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { PassStatus } from './repo.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { Pass } from './repo-map.ts';
import { claimRemovalTrusted, claimRestoreTrusted } from './repo-remove-compensate.ts';
import {
  type RemovalGuard,
  type RemovalInput,
  type RemovalState,
  snapshotParams,
  snapshotSql,
} from './repo-remove-snapshot.ts';
import { readMode, type ScopeArg, scopeOrg } from './scope.ts';

export { reinstateRemoval, releaseRemoval } from './repo-remove-compensate.ts';
export type { RemovalState } from './repo-remove-snapshot.ts';

interface LifecycleRow {
  removed_at: number | null;
  removal_message: string | null;
  removal_prior_status: string | null;
  lifecycle_generation: number;
  removal_published_generation: number | null;
  removal_claim_version: number | null;
  removal_claim_status: PassStatus | null;
  removal_claim_object_key: string | null;
  removal_claim_link_generation: number | null;
}

function permitsWrite(authority: TenantPassWrite): boolean {
  return authority.kind === 'session'
    ? authority.capability === 'passes:operate'
    : authority.scope === 'passes:write';
}

/**
 * One lifecycle transition as a grant: the principal is live, the pass row is the one read (`stale`) and its
 * lifecycle, credential and link generations are unchanged, with no transfer pending (`lineage`). A lost race
 * (stale or lineage) returns null so the caller re-reads; access changes surface as 403.
 */
async function lifecycleGrant(
  ctx: ServiceContext,
  purpose: string,
  guard: RemovalGuard & { authority: TenantPassWrite },
  set: Record<string, string | number | null>,
  where: Record<string, string | number | null>,
): Promise<number | null> {
  const { pass, authority } = guard;
  const g = grant(ctx, {
    purpose,
    principal: tenantPrincipal(authority),
    target: pass.id,
    checks: [
      ...capabilityChecks(authority),
      ...passRow(pass.id, pass.rowVersion),
      rowIs(
        'passes',
        pass.id,
        {
          lifecycle_generation: guard.generation,
          credential_generation: pass.credentialGeneration,
          link_generation: pass.linkGeneration,
          test_data_quarantined: 0,
          deleted_at: null,
        },
        'lineage',
      ),
    ],
    codes: { stale: 'PASS_CONFLICT', lineage: 'PASS_CONFLICT' },
  });
  g.update('passes', {
    set,
    inc: ['lifecycle_generation'],
    where: { id: pass.id, lifecycle_generation: guard.generation, ...where },
    returning: ['lifecycle_generation'],
  });
  try {
    const [result] = await g.commit();
    const row = (result?.results as { lifecycle_generation: number }[] | undefined)?.[0];
    return row?.lifecycle_generation ?? null;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PASS_CONFLICT') return null;
    throw error;
  }
}

const lifecycleColumns = `removed_at, removal_message, removal_prior_status, lifecycle_generation,
  removal_published_generation, removal_claim_version, removal_claim_status, removal_claim_object_key,
  removal_claim_link_generation`;

function toRemoval(row: LifecycleRow): RemovalState | null {
  if (row.removed_at === null) return null;
  return {
    at: row.removed_at,
    message: row.removal_message,
    priorStatus: row.removal_prior_status === 'voided' ? 'voided' : 'active',
    rawPriorStatus: row.removal_prior_status,
    generation: row.lifecycle_generation,
    publishedGeneration: row.removal_published_generation,
    claimVersion: row.removal_claim_version,
    claimStatus: row.removal_claim_status,
    claimObjectKey: row.removal_claim_object_key,
    claimLinkGeneration: row.removal_claim_link_generation,
  };
}

export async function getRemoval(db: D1Database, passId: string): Promise<RemovalState | null> {
  const row = await first<LifecycleRow>(db, `SELECT ${lifecycleColumns} FROM passes WHERE id = ?`, [
    passId,
  ]);
  return row ? toRemoval(row) : null;
}

/** Pin the lifecycle generation to the same pass snapshot read by the service. */
export async function getPassLifecycle(db: D1Database, pass: Pass) {
  const row = await first<LifecycleRow>(
    db,
    `SELECT ${lifecycleColumns} FROM passes WHERE id = ? AND removed_at IS ? AND ${snapshotSql}`,
    [pass.id, pass.removedAt, ...snapshotParams(pass)],
  );
  return row ? { generation: row.lifecycle_generation, removal: toRemoval(row) } : null;
}

/** Claims a new removal and records the exact pre-publication pass snapshot. */
export async function claimRemoval(
  ctx: ServiceContext,
  passId: string,
  state: RemovalInput,
  guard: RemovalGuard,
): Promise<number | null> {
  const { pass, authority } = guard;
  if (pass.removedAt !== null || (authority && !permitsWrite(authority))) return null;
  if (!authority) return claimRemovalTrusted(ctx.env.DB, passId, state, guard);
  return lifecycleGrant(
    ctx,
    'org_mode.pass.remove',
    { ...guard, authority },
    {
      removed_at: state.at,
      removal_message: state.message,
      removal_prior_status: state.priorStatus,
      removal_claim_version: pass.version,
      removal_claim_status: pass.status,
      removal_claim_object_key: pass.objectKey,
      removal_claim_link_generation: pass.linkGeneration,
    },
    { removed_at: null },
  );
}

/** Claims the exact removal and advances the generation even when all other fields repeat. */
export async function claimRestore(
  ctx: ServiceContext,
  passId: string,
  state: RemovalState,
  guard: RemovalGuard,
): Promise<number | null> {
  const { pass, authority } = guard;
  if (pass.removedAt !== state.at || guard.generation !== state.generation) return null;
  if (!authority) return claimRestoreTrusted(ctx.env.DB, passId, state, guard);
  if (!permitsWrite(authority)) return null;
  return lifecycleGrant(
    ctx,
    'org_mode.pass.restore',
    { ...guard, authority },
    { removed_at: null, removal_message: null, removal_prior_status: null },
    {
      removed_at: state.at,
      removal_message: state.message,
      removal_prior_status: state.rawPriorStatus,
      removal_published_generation: state.publishedGeneration,
      removal_claim_version: state.claimVersion,
      removal_claim_status: state.claimStatus,
      removal_claim_object_key: state.claimObjectKey,
      removal_claim_link_generation: state.claimLinkGeneration,
    },
  );
}

/** The proven current removal's version, retained even after its ledger event is purged. */
export async function removalVersion(
  db: D1Database,
  passId: string,
  scope: ScopeArg = null,
): Promise<number | null> {
  const row = await first<{ version: number }>(
    db,
    `SELECT v.version FROM pass_versions v JOIN passes p ON p.id = v.pass_id
     WHERE v.pass_id = ? AND v.source = 'remove' AND v.version <= p.version
       AND p.removed_at IS NOT NULL AND p.status = 'voided'
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
       AND (? IS NULL OR p.org_id = ?) AND (? IS NULL OR p.mode = ?)
       AND p.removal_published_generation = p.lifecycle_generation
     ORDER BY v.version DESC LIMIT 1`,
    [passId, scopeOrg(scope), scopeOrg(scope), readMode(scope), readMode(scope)],
  );
  return row?.version ?? null;
}
