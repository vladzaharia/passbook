import type { Personalization } from '../../../passkit/types.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { blockedUserIds, verifiedCandidates } from '../holders/repo.ts';
import { checkedPass, retainedRelease, stalePass } from './connection-passes-context.ts';
import { type CredentialTransferResult, startCredentialTransfer } from './credential-transfer.ts';
import { publishPass } from './publish.ts';
import { applyConnectionState } from './repo.ts';
import type { ConnectionPassContext } from './repo-connection-context.ts';
import { readCredentialTransfer } from './repo-credential-transfer-read.ts';
import type { FieldSources, Pass } from './repo-map.ts';
import { captureConnectionTransferPending } from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';

export interface ConnectionRecordInput extends ConnectionPassContext {
  /** Mapped template inputs. Fields marked `manual` in field_sources are skipped. */
  fields: Personalization;
  holderEmail?: string | null;
  cause: 'connection' | 'user_refresh';
}

interface ConnectionPassResult {
  version: number;
  ownerUserId: string | null;
  linkGeneration: number;
  identityId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
  credentialKeysetCommitment: string;
  templateId: string;
  templateVersion: string;
  releaseId: string | null;
  transferPending: false;
  /** The committed artifact already enqueued or coalesced its own push. */
  pushQueued: boolean;
}

function mappedFields(
  current: Pass,
  fields: Personalization,
): {
  personalization: Personalization;
  fieldSources: FieldSources;
} {
  const personalization: Personalization = { ...current.personalization };
  const fieldSources: FieldSources = { ...current.fieldSources };
  for (const [key, value] of Object.entries(fields)) {
    if (current.fieldSources[key] === 'manual') continue;
    personalization[key] = value;
    fieldSources[key] = 'connection';
  }
  return { personalization, fieldSources };
}

/** Applies upstream data; publishes only if the built pass changed. */
export async function applyConnectionRecord(
  ctx: ServiceContext,
  input: ConnectionRecordInput,
): Promise<ConnectionPassResult & { changed: boolean }> {
  input = structuredClone(input);
  const pass = await checkedPass(ctx, input);
  const email = input.holderEmail == null ? null : strictEmail(input.holderEmail);
  if (input.holderEmail != null && !email) {
    ctx.log.warn('pass.holder_email_invalid', { passId: pass.id, code: 'EMAIL_INVALID' });
    throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  }
  if (email && email !== pass.holderEmail) {
    const proof = input.retainedReleaseProof;
    const capturedRelease = proof ? await retainedRelease(ctx, pass, proof) : undefined;
    const [candidates, blocked] = await Promise.all([
      verifiedCandidates(ctx.env.DB, email),
      blockedUserIds(ctx.env.DB, pass.id),
    ]);
    const eligible = candidates.filter((candidate) => !blocked.includes(candidate));
    const ownerUserId = eligible.length === 1 ? (eligible[0] ?? null) : null;
    const original = pass;
    let transfer: CredentialTransferResult;
    try {
      transfer = await startCredentialTransfer(
        ctx,
        { type: 'connection', id: input.connectionId },
        pass.id,
        { holderEmail: email, ownerUserId },
        null,
        {
          kind: 'connection',
          expected: pass,
          connection: input,
          content: mappedFields(pass, input.fields),
          audit: {
            orgId: pass.orgId,
            actorType: 'connection',
            actorId: input.connectionId,
            action: 'holder.assign',
            targetType: 'pass',
            targetId: pass.id,
            detail: { changed: true },
          },
        },
      );
    } catch (error) {
      if (proof && error instanceof ConflictError && error.code === 'PASS_CONFLICT')
        await retainedRelease(ctx, pass, proof, capturedRelease);
      throw error;
    }
    if (transfer.state !== 'completed') {
      if (proof) await retainedRelease(ctx, pass, proof, capturedRelease);
      throw new ConflictError(
        'The holder transfer is pending provider retirement.',
        'CONNECTION_TRANSFER_PENDING',
      );
    }

    // Adopt only this transfer's exact, committed transition, never a later pass snapshot.
    const [lineage, completed] = await Promise.all([
      readCredentialTransfer(ctx.env.DB, transfer.transferId),
      getPass(ctx.env.DB, input.passId),
    ]);
    if (
      !lineage ||
      !completed ||
      lineage.state !== 'completed' ||
      lineage.pass_id !== original.id ||
      lineage.org_id !== original.orgId ||
      lineage.mode !== original.mode ||
      lineage.source_generation !== original.credentialGeneration ||
      lineage.source_version !== original.version ||
      lineage.source_revision !== original.revision ||
      lineage.source_lifecycle_generation !== original.lifecycleGeneration ||
      lineage.source_link_generation !== original.linkGeneration + 1 ||
      lineage.target_holder_email !== email ||
      lineage.target_owner_user_id !== ownerUserId ||
      lineage.requested_by_type !== 'connection' ||
      lineage.requested_by_id !== input.connectionId ||
      completed.version !== lineage.source_version + 1 ||
      completed.credentialGeneration !== lineage.target_generation ||
      completed.lifecycleGeneration !== lineage.source_lifecycle_generation ||
      completed.linkGeneration !== lineage.source_link_generation ||
      completed.holderEmail !== email ||
      completed.ownerUserId !== ownerUserId
    )
      throw stalePass();
    if ((await captureConnectionTransferPending(ctx.env.DB, completed)) !== false)
      throw stalePass();
    const context: ConnectionPassContext = {
      ...input,
      expectedVersion: completed.version,
      expectedRowVersion: completed.rowVersion,
      ownerUserId: completed.ownerUserId,
      linkGeneration: completed.linkGeneration,
      identityId: completed.identityId,
      credentialGeneration: completed.credentialGeneration,
      lifecycleGeneration: completed.lifecycleGeneration,
      transferPending: false,
    };
    const checked = await checkedPass(ctx, context);
    if (
      checked.revision !== completed.revision ||
      checked.credentialGeneration !== completed.credentialGeneration ||
      checked.lifecycleGeneration !== completed.lifecycleGeneration ||
      checked.serial !== completed.serial ||
      checked.authToken !== completed.authToken ||
      checked.holderEmail !== completed.holderEmail ||
      checked.objectKey !== completed.objectKey ||
      checked.templateVersion !== completed.templateVersion ||
      checked.releaseId !== completed.releaseId
    )
      throw stalePass();
    if (input.retainedReleaseProof) await retainedRelease(ctx, checked, input.retainedReleaseProof);
    return {
      changed: true,
      version: completed.version,
      ownerUserId: completed.ownerUserId,
      linkGeneration: completed.linkGeneration,
      identityId: completed.identityId,
      credentialGeneration: completed.credentialGeneration,
      lifecycleGeneration: completed.lifecycleGeneration,
      templateId: completed.templateId,
      templateVersion: completed.templateVersion,
      releaseId: completed.releaseId,
      credentialKeysetCommitment: input.credentialKeysetCommitment,
      transferPending: false,
      pushQueued: true,
    };
  }
  const result = await publishPass(ctx, {
    passId: input.passId,
    cause: input.cause,
    actor: { type: 'connection', id: input.connectionId },
    connectionContext: input,
    ...(input.retainedReleaseProof
      ? {
          expectedRelease: {
            id: input.retainedReleaseProof.id,
            generation: input.retainedReleaseProof.generation,
          },
        }
      : {}),
    expectedHolder: pass,
    connectionState: { syncErrorCode: null },
    mutate: (current) => mappedFields(current, input.fields),
  });
  if ((await captureConnectionTransferPending(ctx.env.DB, result.pass)) !== false)
    throw stalePass();
  return {
    changed: result.changed,
    version: result.pass.version,
    ownerUserId: result.pass.ownerUserId,
    linkGeneration: result.pass.linkGeneration,
    identityId: result.pass.identityId,
    credentialGeneration: result.pass.credentialGeneration,
    lifecycleGeneration: result.pass.lifecycleGeneration,
    credentialKeysetCommitment: input.credentialKeysetCommitment,
    templateId: result.pass.templateId,
    templateVersion: result.pass.templateVersion,
    releaseId: result.pass.releaseId,
    transferPending: false,
    pushQueued: result.changed,
  };
}

/** Upstream record missing: flag or void only the exact pass that was fetched. */
export async function markPassMissing(
  ctx: ServiceContext,
  context: ConnectionPassContext,
  mode: 'flag' | 'void',
): Promise<ConnectionPassResult> {
  context = structuredClone(context);
  const pass = await checkedPass(ctx, context);
  if (mode === 'void' && context.status === 'active') {
    const result = await publishPass(ctx, {
      passId: context.passId,
      cause: 'connection',
      actor: { type: 'connection', id: context.connectionId },
      connectionContext: context,
      ...(context.retainedReleaseProof
        ? {
            expectedRelease: {
              id: context.retainedReleaseProof.id,
              generation: context.retainedReleaseProof.generation,
            },
          }
        : {}),
      expectedHolder: pass,
      connectionState: { syncErrorCode: 'RECORD_MISSING' },
      mutate: () => ({ status: 'voided' }),
    });
    if ((await captureConnectionTransferPending(ctx.env.DB, result.pass)) !== false)
      throw stalePass();
    return {
      version: result.pass.version,
      ownerUserId: result.pass.ownerUserId,
      linkGeneration: result.pass.linkGeneration,
      identityId: result.pass.identityId,
      credentialGeneration: result.pass.credentialGeneration,
      lifecycleGeneration: result.pass.lifecycleGeneration,
      credentialKeysetCommitment: context.credentialKeysetCommitment,
      templateId: result.pass.templateId,
      templateVersion: result.pass.templateVersion,
      releaseId: result.pass.releaseId,
      transferPending: false,
      pushQueued: result.changed,
    };
  }
  const proof = context.retainedReleaseProof;
  const release = proof ? await retainedRelease(ctx, pass, proof) : undefined;
  const state = await applyConnectionState(ctx.env.DB, context, pass, 'RECORD_MISSING', release);
  if (!state) {
    if (proof) await retainedRelease(ctx, pass, proof, release);
    throw stalePass();
  }
  if ((await captureConnectionTransferPending(ctx.env.DB, pass)) !== false) throw stalePass();
  return {
    version: state.version,
    ownerUserId: state.ownerUserId,
    linkGeneration: state.linkGeneration,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    credentialKeysetCommitment: context.credentialKeysetCommitment,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    transferPending: false,
    pushQueued: false,
  };
}
