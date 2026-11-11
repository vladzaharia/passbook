import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { retainedWebhookRefHash } from '../connections/webhook-claim-ref.ts';
import type { CreateParams } from './create-types.ts';
import { ensureCredentialRefKeyset, requireCredentialRefKeyset } from './credential-keyset.ts';

export async function captureIssuanceKeyset(ctx: ServiceContext, p: CreateParams): Promise<string> {
  const claim = p.retainedClaim;
  const expected = p.credentialKeysetCommitment;
  if (p.reservedPassId === undefined && claim === undefined) {
    if (p.source !== 'connection') return ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
    const current = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
    if (typeof expected !== 'string' || expected !== current)
      throw new ConflictError(
        'The connection credential context changed. Retry the sync.',
        'PASS_CONFLICT',
      );
    return expected;
  }
  if (
    typeof p.reservedPassId !== 'string' ||
    !p.reservedPassId ||
    p.passId !== undefined ||
    !claim ||
    typeof claim.retentionId !== 'string' ||
    !claim.retentionId ||
    typeof claim.token !== 'string' ||
    !claim.token ||
    !Number.isSafeInteger(claim.ordinal) ||
    claim.ordinal < 0 ||
    !Number.isSafeInteger(claim.revision) ||
    claim.revision < 0 ||
    p.source !== 'connection' ||
    p.execution?.kind !== 'connection' ||
    (p.expectedConnectionMode !== 'webhook' && p.expectedConnectionMode !== 'hybrid') ||
    typeof p.releaseId !== 'string' ||
    !p.releaseId ||
    typeof p.releaseGeneration !== 'number' ||
    !Number.isSafeInteger(p.releaseGeneration) ||
    p.releaseGeneration < 1 ||
    typeof p.connectionId !== 'string' ||
    !p.connectionId ||
    typeof p.externalRef !== 'string' ||
    !p.externalRef
  )
    throw new ConflictError(
      'The retained connection item changed. Retry the sync.',
      'PASS_CONFLICT',
    );
  const commitment = await retainedWebhookRefHash(ctx, p.orgId, p.connectionId, p.externalRef);
  if (
    typeof expected !== 'string' ||
    commitment.refHash !== claim.refHash ||
    commitment.credentialKeysetCommitment !== claim.credentialKeysetCommitment ||
    commitment.credentialKeysetCommitment !== expected
  )
    throw new ConflictError(
      'The retained connection item changed. Retry the sync.',
      'PASS_CONFLICT',
    );
  return expected;
}
