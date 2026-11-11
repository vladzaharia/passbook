import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPassForWrite } from './pass-access.ts';
import type { PublishOptions } from './publish.ts';
import type { Pass } from './repo.ts';
import { matchesConnectionPass } from './repo-read-connection.ts';
import {
  getPublishRemovalSnapshot,
  type PublishRemovalSnapshot,
} from './repo-write-publish-snapshot.ts';

export interface PublishSnapshotState {
  original: Pass | null;
  originalRemoval: PublishRemovalSnapshot | null;
  originalImageGeneration: number | null;
}

/** Capture the original pass and removal state across compare-and-swap retries. */
export async function capturePublishSnapshot(
  ctx: ServiceContext,
  options: PublishOptions,
  state: PublishSnapshotState,
) {
  const db = ctx.env.DB;
  if (options.connectionContext && !(await matchesConnectionPass(db, options.connectionContext)))
    throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
  const current = await getPassForWrite(db, options.passId, options.orgScope ?? null);
  if (
    options.authority &&
    (current.orgId !== options.authority.orgId || current.mode !== options.authority.mode)
  )
    throw new ConflictError('The pass or your access changed. Reload and retry.', 'PASS_CONFLICT');
  if (
    options.connectionContext &&
    (options.connectionContext.passId !== current.id ||
      (options.expectedHolder &&
        (current.holderEmail !== options.expectedHolder.holderEmail ||
          current.ownerUserId !== options.expectedHolder.ownerUserId)))
  )
    throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
  if (!state.original) {
    state.original = current;
  } else if (
    current.orgId !== state.original.orgId ||
    current.mode !== state.original.mode ||
    current.templateId !== state.original.templateId ||
    current.templateVersion !== state.original.templateVersion ||
    current.releaseId !== state.original.releaseId ||
    current.status !== state.original.status ||
    current.linkGeneration !== state.original.linkGeneration ||
    current.credentialGeneration !== state.original.credentialGeneration ||
    current.lifecycleGeneration !== state.original.lifecycleGeneration ||
    current.serial !== state.original.serial ||
    current.authToken !== state.original.authToken ||
    current.holderEmail !== state.original.holderEmail ||
    current.ownerUserId !== state.original.ownerUserId ||
    current.removedAt !== state.original.removedAt
  ) {
    throw new ConflictError('Pass credentials or holder changed. Reload.', 'PASS_CONFLICT');
  }
  if (options.expectedVersion !== undefined && current.version !== options.expectedVersion)
    throw new PreconditionFailedError();
  if (
    options.expectedPass &&
    (current.version !== options.expectedPass.version ||
      current.status !== options.expectedPass.status ||
      current.objectKey !== options.expectedPass.objectKey)
  )
    throw new ConflictError('The staged pass changed. Reload and retry.', 'PASS_CONFLICT');
  const removalSnapshot = await getPublishRemovalSnapshot(db, current, options.source === 'remove');
  if (!removalSnapshot) {
    if (options.connectionContext)
      throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
    if (options.expectedPass || options.expectedRemoval)
      throw new ConflictError('The staged pass changed. Reload and retry.', 'PASS_CONFLICT');
    if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
    return null;
  }
  const expectedRemoval = options.expectedRemoval ?? state.originalRemoval;
  if (
    expectedRemoval &&
    (removalSnapshot.at !== expectedRemoval.at ||
      removalSnapshot.generation !== expectedRemoval.generation ||
      removalSnapshot.message !== expectedRemoval.message ||
      removalSnapshot.priorStatus !== expectedRemoval.priorStatus)
  )
    throw new ConflictError('The pass removal changed. Reload and retry.', 'PASS_CONFLICT');
  if (
    (options.expectedImageGeneration !== undefined &&
      removalSnapshot.imageGeneration !== options.expectedImageGeneration) ||
    (state.originalImageGeneration !== null &&
      removalSnapshot.imageGeneration !== state.originalImageGeneration)
  )
    throw new ConflictError('The pass images changed. Reload and retry.', 'PASS_CONFLICT');
  state.originalImageGeneration ??= removalSnapshot.imageGeneration;
  state.originalRemoval ??= removalSnapshot;
  return { current, removalSnapshot };
}
