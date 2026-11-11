import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { presentationForPass } from '../public/presentation.ts';
import { capturePassSnapshot } from '../public/snapshot.ts';
import { getMyPass } from './repo.ts';

/** Recheck owner and exact credential incarnation, including the pending-transfer fence. */
export async function assertOwnerPass(ctx: ServiceContext, userId: string, pass: Pass) {
  const row = await getMyPass(ctx.env.DB, userId, pass.id);
  if (
    !row ||
    row.identity_id !== pass.identityId ||
    row.credential_generation !== pass.credentialGeneration ||
    row.lifecycle_generation !== pass.lifecycleGeneration ||
    row.link_generation !== pass.linkGeneration ||
    row.download_token !== pass.downloadToken ||
    row.version !== pass.version ||
    row.revision !== pass.revision
  ) {
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  }
}

/** A session and the current owner are both required, independently of the bearer link. */
export async function presentationForOwner(ctx: ServiceContext, userId: string, passId: string) {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass || pass.ownerUserId !== userId) {
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  }
  await assertOwnerPass(ctx, userId, pass);
  const snapshot = await capturePassSnapshot(ctx, pass);
  const model = await presentationForPass(ctx, pass);
  await assertOwnerPass(ctx, userId, pass);
  return { model, snapshot };
}
