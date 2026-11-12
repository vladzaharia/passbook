import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type ConnectionMode,
  ConnectionModeSchema,
} from '../../../shared/contracts/connections.ts';
import type { SqlValue } from '../../platform/db.ts';

export interface RefreshSnapshot {
  passId: string;
  orgId: string;
  identityId: string;
  templateId: string;
  templateVersion: string;
  releaseId: string | null;
  mode: Mode;
  status: 'active' | 'voided';
  passVersion: number;
  connectionId: string | null;
  externalRef: string | null;
  generation: number | null;
  connectionMode: ConnectionMode | null;
  ownerUserId: string | null;
  linkGeneration: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
  credentialKeysetCommitment: string;
}

export const refreshPredicate = `org_id = ? AND mode = ? AND status = ? AND version = ?
  AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0 AND connection_id IS ? AND external_ref IS ?
  AND owner_user_id IS ? AND link_generation = ? AND identity_id = ?
  AND credential_generation = ? AND lifecycle_generation = ?
  AND template_id = ? AND template_version = ? AND release_id IS ?
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
  AND ((connection_id IS NULL AND external_ref IS NULL AND ? IS NULL AND ? IS NULL)
    OR (mode = 'live' AND status = 'active' AND connection_id IS NOT NULL AND external_ref IS NOT NULL
      AND EXISTS (SELECT 1 FROM connections c WHERE c.id = passes.connection_id
        AND c.org_id = passes.org_id AND c.enabled = 1 AND c.generation = ? AND c.mode = ?)))`;

export function refreshParams(snapshot: RefreshSnapshot): SqlValue[] {
  return [
    snapshot.orgId,
    snapshot.mode,
    snapshot.status,
    snapshot.passVersion,
    snapshot.connectionId,
    snapshot.externalRef,
    snapshot.ownerUserId,
    snapshot.linkGeneration,
    snapshot.identityId,
    snapshot.credentialGeneration,
    snapshot.lifecycleGeneration,
    snapshot.templateId,
    snapshot.templateVersion,
    snapshot.releaseId,
    snapshot.generation,
    snapshot.connectionMode,
    snapshot.generation,
    snapshot.connectionMode,
  ];
}

export function validRefreshEpochs(snapshot: RefreshSnapshot): boolean {
  return (
    typeof snapshot.identityId === 'string' &&
    snapshot.identityId.length > 0 &&
    typeof snapshot.templateId === 'string' &&
    snapshot.templateId.length > 0 &&
    typeof snapshot.templateVersion === 'string' &&
    snapshot.templateVersion.length > 0 &&
    (snapshot.releaseId === null ||
      (typeof snapshot.releaseId === 'string' && snapshot.releaseId.length > 0)) &&
    typeof snapshot.credentialKeysetCommitment === 'string' &&
    /^[0-9a-f]{64}$/.test(snapshot.credentialKeysetCommitment) &&
    Number.isSafeInteger(snapshot.credentialGeneration) &&
    snapshot.credentialGeneration > 0 &&
    Number.isSafeInteger(snapshot.lifecycleGeneration) &&
    snapshot.lifecycleGeneration >= 0 &&
    (snapshot.connectionId === null
      ? snapshot.externalRef === null &&
        snapshot.generation === null &&
        snapshot.connectionMode === null
      : typeof snapshot.connectionId === 'string' &&
        snapshot.connectionId.length > 0 &&
        typeof snapshot.externalRef === 'string' &&
        snapshot.externalRef.length > 0 &&
        Number.isSafeInteger(snapshot.generation) &&
        (snapshot.generation ?? 0) > 0 &&
        ConnectionModeSchema.safeParse(snapshot.connectionMode).success)
  );
}
