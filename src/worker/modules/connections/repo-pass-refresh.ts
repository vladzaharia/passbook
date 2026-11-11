import { ConnectionModeSchema } from '../../../shared/contracts/connections.ts';
import type { JobOf } from '../../jobs/types.ts';
import { first } from '../../platform/db.ts';
import { validCredentialKeysetCommitment, validPassReleaseBinding } from './repo-passes.ts';

export type RefreshSnapshot = Pick<
  JobOf<'pass.refresh'>,
  | 'passId'
  | 'orgId'
  | 'identityId'
  | 'templateId'
  | 'templateVersion'
  | 'releaseId'
  | 'mode'
  | 'passVersion'
  | 'status'
  | 'ownerUserId'
  | 'linkGeneration'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'credentialKeysetCommitment'
  | 'connectionId'
  | 'connectionMode'
  | 'externalRef'
  | 'generation'
>;

const REFRESH_GUARD = `id = ? AND org_id = ? AND identity_id = ? AND mode = ? AND status = ? AND version = ?
  AND credential_generation = ? AND lifecycle_generation = ?
  AND template_id = ? AND template_version = ? AND release_id IS ?
  AND owner_user_id IS ? AND link_generation = ? AND connection_id IS ? AND external_ref IS ?
  AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pct
    WHERE pct.pass_id = passes.id AND pct.state = 'pending')
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = ? AND o.status = 'active')
  AND (? IS NULL OR EXISTS (SELECT 1 FROM connections c
    WHERE c.id = ? AND c.org_id = ? AND c.enabled = 1 AND c.generation = ? AND c.mode = ?))`;

function refreshParams(p: RefreshSnapshot): (string | number | null)[] {
  return [
    p.passId,
    p.orgId,
    p.identityId,
    p.mode,
    p.status,
    p.passVersion,
    p.credentialGeneration,
    p.lifecycleGeneration,
    p.templateId,
    p.templateVersion,
    p.releaseId,
    p.ownerUserId,
    p.linkGeneration,
    p.connectionId,
    p.externalRef,
    p.orgId,
    p.connectionId,
    p.connectionId,
    p.orgId,
    p.generation,
    p.connectionMode,
  ];
}

/** Runtime checks also reject old queue messages and inconsistent bindings. */
export function validRefreshSnapshot(p: RefreshSnapshot): boolean {
  if (
    typeof p.passId !== 'string' ||
    !p.passId ||
    typeof p.orgId !== 'string' ||
    !p.orgId ||
    typeof p.identityId !== 'string' ||
    !p.identityId ||
    (p.mode !== 'live' && p.mode !== 'test') ||
    !validPassReleaseBinding(p) ||
    !validCredentialKeysetCommitment(p.credentialKeysetCommitment) ||
    !Number.isSafeInteger(p.passVersion) ||
    p.passVersion < 1 ||
    !Number.isSafeInteger(p.credentialGeneration) ||
    p.credentialGeneration < 1 ||
    !Number.isSafeInteger(p.lifecycleGeneration) ||
    p.lifecycleGeneration < 0 ||
    !Number.isSafeInteger(p.linkGeneration) ||
    p.linkGeneration < 1 ||
    (p.status !== 'active' && p.status !== 'voided') ||
    (p.ownerUserId !== null && typeof p.ownerUserId !== 'string')
  )
    return false;
  if (p.connectionId === null) {
    return p.externalRef === null && p.generation === null && p.connectionMode === null;
  }
  return (
    typeof p.connectionId === 'string' &&
    p.connectionId.length > 0 &&
    p.mode === 'live' &&
    p.status === 'active' &&
    typeof p.externalRef === 'string' &&
    p.externalRef.length > 0 &&
    p.connectionMode !== null &&
    ConnectionModeSchema.options.includes(p.connectionMode) &&
    typeof p.generation === 'number' &&
    Number.isSafeInteger(p.generation) &&
    p.generation > 0
  );
}

export async function refreshSnapshotCurrent(db: D1Database, p: RefreshSnapshot): Promise<boolean> {
  if (!validRefreshSnapshot(p)) return false;
  return (
    (await first(db, `SELECT 1 FROM passes WHERE ${REFRESH_GUARD}`, refreshParams(p))) !== null
  );
}
