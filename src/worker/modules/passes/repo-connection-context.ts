import {
  type ConnectionMode,
  ConnectionModeSchema,
} from '../../../shared/contracts/connections.ts';
import type { SqlValue } from '../../platform/db.ts';

/** The immutable context of one upstream result. Never fill missing fields from a later read. */
export interface ConnectionPassContext {
  passId: string;
  orgId: string;
  identityId: string;
  mode: 'live';
  status: 'active' | 'voided';
  expectedVersion: number;
  /** The pass row_version read with the context; the row-level fence once the write is a grant. */
  expectedRowVersion?: number;
  ownerUserId: string | null;
  linkGeneration: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
  credentialKeysetCommitment: string;
  transferPending: boolean;
  connectionId: string;
  externalRef: string;
  generation: number;
  /** The connection strategy captured when this work began. */
  expectedConnectionMode: ConnectionMode;
  /** Release admitted with a retained refs-only webhook, not a later release lookup. */
  retainedReleaseProof?: { id: string; generation: number; version: string };
  /** Original template binding captured by retained work or an explicit refresh. */
  retainedBinding?: {
    templateId: string;
    releaseId: string | null;
    templateVersion: string;
    credentialKeysetCommitment: string;
  };
}

/** SQL and parameters shared by every final connector-owned write. */
export const connectionPassPredicate = `org_id = ? AND mode = ? AND mode = 'live'
  AND status = ? AND version = ? AND (? IS NULL OR row_version = ?) AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
  AND connection_id = ? AND external_ref = ? AND owner_user_id IS ? AND link_generation = ?
  AND identity_id = ? AND credential_generation = ? AND lifecycle_generation = ?
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
  AND (? IS NULL OR (release_id = ? AND template_version = ?))
  AND (? IS NULL OR (passes.template_id = ? AND passes.release_id IS ? AND passes.template_version = ?))
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
  AND EXISTS (SELECT 1 FROM connections c WHERE c.id = passes.connection_id
    AND c.org_id = passes.org_id AND c.enabled = 1 AND c.generation = ?
    AND c.mode = ?)`;

export function connectionPassParams(context: ConnectionPassContext): SqlValue[] {
  return [
    context.orgId,
    context.mode,
    context.status,
    context.expectedVersion,
    context.expectedRowVersion ?? null,
    context.expectedRowVersion ?? null,
    context.connectionId,
    context.externalRef,
    context.ownerUserId,
    context.linkGeneration,
    context.identityId,
    context.credentialGeneration,
    context.lifecycleGeneration,
    context.retainedReleaseProof?.id ?? null,
    context.retainedReleaseProof?.id ?? null,
    context.retainedReleaseProof?.version ?? null,
    context.retainedBinding?.templateId ?? null,
    context.retainedBinding?.templateId ?? null,
    context.retainedBinding?.releaseId ?? null,
    context.retainedBinding?.templateVersion ?? null,
    context.generation,
    context.expectedConnectionMode,
  ];
}
function validConnectionBinding(binding: unknown): boolean {
  return (
    binding === undefined ||
    (binding !== null &&
      typeof binding === 'object' &&
      'templateId' in binding &&
      typeof binding.templateId === 'string' &&
      binding.templateId.length > 0 &&
      'templateVersion' in binding &&
      typeof binding.templateVersion === 'string' &&
      binding.templateVersion.length > 0 &&
      'releaseId' in binding &&
      (binding.releaseId === null ||
        (typeof binding.releaseId === 'string' && binding.releaseId.length > 0)) &&
      'credentialKeysetCommitment' in binding &&
      typeof binding.credentialKeysetCommitment === 'string' &&
      /^[0-9a-f]{64}$/.test(binding.credentialKeysetCommitment))
  );
}

export function validConnectionPassContext(context: ConnectionPassContext): boolean {
  return Boolean(
    context &&
      typeof context.passId === 'string' &&
      context.passId &&
      typeof context.orgId === 'string' &&
      context.orgId &&
      typeof context.identityId === 'string' &&
      context.identityId.length > 0 &&
      context.mode === 'live' &&
      (context.status === 'active' || context.status === 'voided') &&
      Number.isSafeInteger(context.expectedVersion) &&
      context.expectedVersion > 0 &&
      (context.expectedRowVersion === undefined ||
        (Number.isSafeInteger(context.expectedRowVersion) && context.expectedRowVersion > 0)) &&
      (context.ownerUserId === null || typeof context.ownerUserId === 'string') &&
      Number.isSafeInteger(context.linkGeneration) &&
      context.linkGeneration > 0 &&
      Number.isSafeInteger(context.credentialGeneration) &&
      context.credentialGeneration > 0 &&
      Number.isSafeInteger(context.lifecycleGeneration) &&
      context.lifecycleGeneration >= 0 &&
      typeof context.credentialKeysetCommitment === 'string' &&
      /^[0-9a-f]{64}$/.test(context.credentialKeysetCommitment) &&
      context.transferPending === false &&
      typeof context.connectionId === 'string' &&
      context.connectionId &&
      typeof context.externalRef === 'string' &&
      context.externalRef &&
      Number.isSafeInteger(context.generation) &&
      context.generation > 0 &&
      ConnectionModeSchema.safeParse(context.expectedConnectionMode).success &&
      validConnectionBinding(context.retainedBinding) &&
      (context.retainedBinding === undefined ||
        context.retainedBinding.credentialKeysetCommitment ===
          context.credentialKeysetCommitment) &&
      (context.retainedReleaseProof === undefined ||
        ((context.expectedConnectionMode === 'webhook' ||
          context.expectedConnectionMode === 'hybrid') &&
          context.retainedReleaseProof !== null &&
          typeof context.retainedReleaseProof === 'object' &&
          typeof context.retainedReleaseProof.id === 'string' &&
          context.retainedReleaseProof.id.length > 0 &&
          Number.isSafeInteger(context.retainedReleaseProof.generation) &&
          context.retainedReleaseProof.generation > 0 &&
          typeof context.retainedReleaseProof.version === 'string' &&
          context.retainedReleaseProof.version.length > 0)),
  );
}
