import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import {
  type ConnectionPassContext,
  connectionPassParams,
  connectionPassPredicate,
  validConnectionPassContext,
} from './repo-connection-context.ts';
import type { Pass } from './repo-map.ts';
import {
  approvedReleaseFence,
  noApprovedReleaseFence,
  type PassReleaseSnapshot,
  validPassReleaseSnapshot,
} from './repo-release.ts';
import {
  permitsPassMutation,
  tenantPassWriteParams,
  tenantPassWriteSql,
} from './repo-write-authority.ts';
import { casConnector } from './repo-write-publish-connector.ts';

export interface PublishRemovalSnapshot {
  at: number | null;
  generation: number;
  message: string | null;
  /** Raw stored value, including legacy NULL or nonstandard values. */
  priorStatus: string | null;
}

type CapturedPublishRemoval = PublishRemovalSnapshot & {
  publishedGeneration: number | null;
  imageGeneration: number;
};

type PublishPassBaseSnapshot = Pick<
  Pass,
  | 'orgId'
  | 'mode'
  | 'templateId'
  | 'templateVersion'
  | 'releaseId'
  | 'rowVersion'
  | 'revision'
  | 'serial'
  | 'authToken'
  | 'holderEmail'
  | 'ownerUserId'
  | 'linkGeneration'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'status'
  | 'removedAt'
  | 'objectKey'
>;

export type PublishPassSnapshot = PublishPassBaseSnapshot & {
  imageGeneration: number;
  credentialKeysetCommitment: string;
  credentialRefs: string[];
  removalMessage: string | null;
  removalPriorStatus: string | null;
  removalPublishedGeneration: number | null;
};

type IdentifiedPublishSnapshot = PublishPassSnapshot & Pick<Pass, 'id' | 'version'>;

export function permitsPublishRelease(
  pass: PublishPassBaseSnapshot,
  templateVersion: string,
  release: PassReleaseSnapshot | undefined,
  requireNoReleaseHistory: boolean,
): boolean {
  if (release !== undefined && !validPassReleaseSnapshot(release)) return false;
  const changesTemplateVersion = templateVersion !== pass.templateVersion;
  if (changesTemplateVersion && !release) return false;
  if (requireNoReleaseHistory)
    return !changesTemplateVersion && pass.releaseId === null && release === undefined;
  return true;
}

export function publishReleaseFence(
  pass: PublishPassBaseSnapshot,
  templateVersion: string,
  release: PassReleaseSnapshot | undefined,
  requireNoReleaseHistory: boolean,
) {
  if (release)
    return approvedReleaseFence(release, pass.templateId, pass.orgId, pass.mode, templateVersion);
  return requireNoReleaseHistory
    ? noApprovedReleaseFence(pass.templateId, pass.orgId, pass.mode)
    : undefined;
}

/**
 * The pass as the publish read it: one `row_version` comparison (every content, credential, lifecycle and
 * removal column moves it; sync metadata never does), plus the lifecycle, credential and link generations,
 * which are authority and are compared directly. The generations also make a transfer or void between the
 * read and the write a lineage miss. Credential references and the keyset are not rechecked here: the keyset
 * row is immutable and a tombstone cannot exist for the current generation (authority-epochs.md F3, F10).
 */
const basePublishSnapshotPredicate = `org_id = ? AND mode = ? AND template_id = ? AND row_version = ?
  AND credential_generation = ? AND lifecycle_generation = ? AND link_generation = ?
  AND deleted_at IS NULL AND test_data_quarantined = 0
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')`;
export const publishSnapshotPredicate = basePublishSnapshotPredicate;
export const removalClaimPredicate = `removal_claim_version = ? AND removal_claim_status = ?
  AND removal_claim_object_key = ? AND removal_claim_link_generation = ?`;

function basePublishSnapshotParams(pass: PublishPassBaseSnapshot) {
  return [
    pass.orgId,
    pass.mode,
    pass.templateId,
    pass.rowVersion,
    pass.credentialGeneration,
    pass.lifecycleGeneration,
    pass.linkGeneration,
  ];
}

export function publishSnapshotParams(pass: PublishPassSnapshot) {
  return basePublishSnapshotParams(pass);
}

export function removalClaimParams(
  version: number,
  pass: Pick<Pass, 'status' | 'objectKey' | 'linkGeneration'>,
) {
  return [version, pass.status, pass.objectKey, pass.linkGeneration];
}

/** Reads the raw removal state only while the pass still matches the original publish input. */
export async function getPublishRemovalSnapshot(
  db: D1Database,
  pass: Pass,
  requireRemovalClaim = false,
): Promise<CapturedPublishRemoval | null> {
  const row = await first<{
    removal_message: string | null;
    removal_prior_status: string | null;
    lifecycle_generation: number;
    removal_published_generation: number | null;
    image_generation: number;
  }>(
    db,
    `SELECT removal_message, removal_prior_status, lifecycle_generation, removal_published_generation, image_generation FROM passes
     WHERE id = ? AND version = ? AND ${basePublishSnapshotPredicate}
       ${requireRemovalClaim ? `AND ${removalClaimPredicate}` : ''}`,
    [
      pass.id,
      pass.version,
      ...basePublishSnapshotParams(pass),
      ...(requireRemovalClaim ? removalClaimParams(pass.version, pass) : []),
    ],
  );
  return row
    ? {
        at: pass.removedAt,
        generation: row.lifecycle_generation,
        publishedGeneration: row.removal_published_generation,
        imageGeneration: row.image_generation,
        message: row.removal_message,
        priorStatus: row.removal_prior_status,
      }
    : null;
}

/** Revalidates the exact build input before writing its artifact to R2. */
export async function matchesPublishSnapshot(
  db: D1Database,
  pass: IdentifiedPublishSnapshot,
  connectionContext?: ConnectionPassContext,
  authority?: TenantPassWrite,
  now?: number,
  requireRemovalClaim = false,
  release?: PassReleaseSnapshot,
  requireNoReleaseHistory = false,
  releaseVersion = pass.templateVersion,
): Promise<boolean> {
  if (!permitsPassMutation(authority)) return false;
  if (!permitsPublishRelease(pass, releaseVersion, release, requireNoReleaseHistory)) return false;
  const releaseFence = publishReleaseFence(pass, releaseVersion, release, requireNoReleaseHistory);
  if (authority && now === undefined)
    throw new Error('A clock time is required for tenant authority.');
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND version = ? AND ${publishSnapshotPredicate}
      ${releaseFence ? `AND ${releaseFence.sql}` : ''}
      ${connectionContext ? `AND ${connectionPassPredicate}` : ''}
      ${authority ? `AND ${tenantPassWriteSql(authority)}` : ''}
      ${requireRemovalClaim ? `AND ${removalClaimPredicate}` : ''}`,
    [
      pass.id,
      pass.version,
      ...publishSnapshotParams(pass),
      ...(releaseFence?.params ?? []),
      ...(connectionContext ? connectionPassParams(connectionContext) : []),
      ...(authority && now !== undefined ? tenantPassWriteParams(authority, now) : []),
      ...(requireRemovalClaim ? removalClaimParams(pass.version, pass) : []),
    ],
  );
  return row !== null;
}

/** Changes connector state only while the publish snapshot and any tenant authority still match. */
export async function applyPublishConnectionState(
  ctx: ServiceContext,
  context: ConnectionPassContext,
  expectedPass: IdentifiedPublishSnapshot,
  code: string | null,
  authority?: TenantPassWrite,
  release?: PassReleaseSnapshot,
  requireNoReleaseHistory = false,
): Promise<boolean> {
  if (!validConnectionPassContext(context) || !permitsPassMutation(authority)) return false;
  if (
    !permitsPublishRelease(
      expectedPass,
      expectedPass.templateVersion,
      release,
      requireNoReleaseHistory,
    )
  )
    return false;
  return (
    (await casConnector(ctx, {
      id: context.passId,
      expectedVersion: expectedPass.version,
      expectedPass,
      release,
      requireNoReleaseHistory,
      set: { sync_error_code: code },
      bumpVersion: false,
      context,
      authority,
    })) !== null
  );
}
