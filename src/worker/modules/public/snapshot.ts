import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { currentPublicGeneration } from './repo.ts';

export interface PassSnapshot {
  pass: Pass;
  linkGeneration: number;
  credentialGeneration: number;
}

/** Pin the current owner, token, credential and artifact before reading mutable data or R2 objects. */
export async function capturePassSnapshot(ctx: ServiceContext, pass: Pass): Promise<PassSnapshot> {
  const generation = await currentPublicGeneration(ctx.env.DB, pass);
  if (generation === null) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return { pass, ...generation };
}

/** Fence the response after the reads; a changed or suspended pass is no longer disclosed. */
export async function assertPassSnapshot(
  ctx: ServiceContext,
  snapshot: PassSnapshot,
): Promise<void> {
  const generation = await currentPublicGeneration(ctx.env.DB, snapshot.pass);
  if (
    generation === null ||
    generation.linkGeneration !== snapshot.linkGeneration ||
    generation.credentialGeneration !== snapshot.credentialGeneration
  ) {
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  }
}
