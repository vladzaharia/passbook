import type { SqlValue } from '../../platform/db.ts';
import type { TenantPassWrite } from './http.ts';
import type { PassStatus } from './repo.ts';
import type { Pass } from './repo-map.ts';

export interface RemovalInput {
  at: number;
  message: string | null;
  priorStatus: PassStatus;
}

export interface RemovalState extends RemovalInput {
  rawPriorStatus: string | null;
  generation: number;
  publishedGeneration: number | null;
  claimVersion: number | null;
  claimStatus: PassStatus | null;
  claimObjectKey: string | null;
  claimLinkGeneration: number | null;
}

/** A removal that must not claim a pass that moved on: its version is the one given and no scan names it. */
export interface RemovalFence {
  version: number;
  noScans: boolean;
  /** A deferred run's starter proof (a bare SELECT): the trusted claim commits only while it holds. */
  proof?: { sql: string; params: readonly SqlValue[] };
}

export interface RemovalGuard {
  pass: Pass;
  fence?: RemovalFence;
  generation: number;
  now: number;
  authority?: TenantPassWrite;
}

export const snapshotSql = `org_id = ? AND mode = ? AND version = ? AND template_id = ?
  AND template_version = ? AND serial = ? AND auth_token = ? AND holder_email IS ?
  AND owner_user_id IS ? AND link_generation = ? AND status = ? AND object_key = ?
  AND deleted_at IS NULL AND test_data_quarantined = 0`;

export function snapshotParams(pass: Pass) {
  return [
    pass.orgId,
    pass.mode,
    pass.version,
    pass.templateId,
    pass.templateVersion,
    pass.serial,
    pass.authToken,
    pass.holderEmail,
    pass.ownerUserId,
    pass.linkGeneration,
    pass.status,
    pass.objectKey,
  ];
}
