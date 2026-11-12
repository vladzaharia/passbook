import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import {
  approvedReleaseFence,
  type PassReleaseSnapshot,
  validPassReleaseSnapshot,
} from './repo-release.ts';

/** The currently started retained webhook item authorizing a reserved pass ID. */
export interface RetainedIssuanceClaim {
  retentionId: string;
  ordinal: number;
  token: string;
  revision: number;
  refHash: string;
  credentialKeysetCommitment: string;
}

export interface RetainedIssuanceScope {
  claim: RetainedIssuanceClaim;
  passId: string;
  orgId: string;
  connectionId: string;
  connectionGeneration: number;
  connectionMode: ConnectionMode;
  templateId: string;
  release: PassReleaseSnapshot;
  releaseVersion: string;
}

export function validRetainedIssuance(scope: RetainedIssuanceScope): boolean {
  const c = scope.claim;
  return (
    !!c &&
    typeof c.retentionId === 'string' &&
    c.retentionId.length > 0 &&
    Number.isSafeInteger(c.ordinal) &&
    c.ordinal >= 0 &&
    typeof c.token === 'string' &&
    c.token.length > 0 &&
    Number.isSafeInteger(c.revision) &&
    c.revision >= 0 &&
    typeof c.refHash === 'string' &&
    /^[0-9a-f]{64}$/.test(c.refHash) &&
    typeof c.credentialKeysetCommitment === 'string' &&
    /^[0-9a-f]{64}$/.test(c.credentialKeysetCommitment) &&
    !!scope.passId &&
    !!scope.orgId &&
    !!scope.connectionId &&
    Number.isSafeInteger(scope.connectionGeneration) &&
    scope.connectionGeneration > 0 &&
    (scope.connectionMode === 'webhook' || scope.connectionMode === 'hybrid') &&
    !!scope.templateId &&
    !!scope.releaseVersion &&
    validPassReleaseSnapshot(scope.release)
  );
}

/** `orgTerm` is `?` (bound to the scope's org), or null for the org-free part of a grant check. */
function retainedFenceSql(orgTerm: string | null): string {
  return `EXISTS (SELECT 1 FROM connection_webhook_items i
      JOIN connection_webhook_retention r ON r.id = i.retention_id
      WHERE i.retention_id = ? AND i.ordinal = ? AND i.token = ? AND i.state = 'started'
        AND i.claim_kind = 'new' AND i.claim_pass_id = ? AND i.claim_revision = ?
        AND i.prior_unknown = 0 AND i.claim_prior_unbound = 0
        AND r.revision = i.claim_revision AND r.state = 'pending' AND r.source = 'ingress'
        AND r.snapshot_known = 1${orgTerm === null ? '' : ` AND r.org_id = ${orgTerm}`} AND r.connection_id = ? AND r.generation = ? AND r.connection_mode = ?
        AND r.release_snapshot = i.release_snapshot
        AND r.credential_keyset_commitment = ?
        AND json_extract(i.claim_snapshot, '$.kind') = 'new'
        AND json_extract(i.claim_snapshot, '$.passId') = i.claim_pass_id
        ${orgTerm === null ? '' : "AND json_extract(i.claim_snapshot, '$.orgId') = r.org_id"}
        AND json_extract(i.claim_snapshot, '$.connectionId') = r.connection_id
        AND json_extract(i.claim_snapshot, '$.generation') = r.generation
        AND json_extract(i.claim_snapshot, '$.connectionMode') = r.connection_mode
        AND json_extract(i.claim_snapshot, '$.refHash') = ?
        AND json_extract(i.claim_snapshot, '$.credentialKeysetCommitment') = ?
        AND json_extract(i.claim_snapshot, '$.templateId') = ?
        AND json_extract(i.claim_snapshot, '$.expectedRelease.kind') = 'approved'
        AND json_extract(i.claim_snapshot, '$.expectedRelease.id') = ?
        AND json_extract(i.claim_snapshot, '$.expectedRelease.generation') = ?
        AND json_extract(i.claim_snapshot, '$.expectedRelease.version') = ?
        AND json_extract(r.release_snapshot, '$.kind') = 'approved'
        AND json_extract(r.release_snapshot, '$.id') = ?
        AND json_extract(r.release_snapshot, '$.generation') = ?
        AND json_extract(r.release_snapshot, '$.version') = ?)`;
}

function retainedFenceParams(scope: RetainedIssuanceScope, withOrg: boolean): SqlValue[] {
  const c = scope.claim;
  return [
    c.retentionId,
    c.ordinal,
    c.token,
    scope.passId,
    c.revision,
    ...(withOrg ? [scope.orgId] : []),
    scope.connectionId,
    scope.connectionGeneration,
    scope.connectionMode,
    c.credentialKeysetCommitment,
    c.refHash,
    c.credentialKeysetCommitment,
    scope.templateId,
    scope.release.id,
    scope.release.generation,
    scope.releaseVersion,
    scope.release.id,
    scope.release.generation,
    scope.releaseVersion,
  ];
}

export function retainedIssuanceFence(scope: RetainedIssuanceScope): {
  sql: string;
  params: SqlValue[];
} {
  return { sql: retainedFenceSql('?'), params: retainedFenceParams(scope, true) };
}

/**
 * The same proof as grant checks. The JSON and column proof names no org (a raw check cannot); the
 * retention row is tied to the grant's own org separately.
 */
export function retainedIssuanceChecks(scope: RetainedIssuanceScope): Check[] {
  return [
    rawCheck('retention', retainedFenceSql(null), retainedFenceParams(scope, false)),
    tenantCheck(
      'retention',
      `EXISTS (SELECT 1 FROM connection_webhook_retention r JOIN connection_webhook_items i ON i.retention_id = r.id
        WHERE r.id = ? AND i.ordinal = ? AND r.org_id = {org})`,
      [scope.claim.retentionId, scope.claim.ordinal],
    ),
  ];
}

/** A retry may acknowledge a reserved winner only under the same live item and release. */
export async function matchesRetainedIssuanceClaim(
  db: D1Database,
  scope: RetainedIssuanceScope,
): Promise<boolean> {
  if (!validRetainedIssuance(scope)) return false;
  const claim = retainedIssuanceFence(scope);
  const release = approvedReleaseFence(
    scope.release,
    scope.templateId,
    scope.orgId,
    'live',
    scope.releaseVersion,
  );
  return (
    (await first(db, `SELECT 1 WHERE ${claim.sql} AND ${release.sql}`, [
      ...claim.params,
      ...release.params,
    ])) !== null
  );
}
