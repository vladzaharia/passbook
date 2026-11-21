import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { HANDLE_PATTERN, handleBase, handleCandidates, RESERVED_HANDLES } from './handles.ts';
import { beginStep, patchRef } from './provision-run.ts';
import { handleOfOrg } from './repo-provision.ts';
import { handleOwner, reserveHandleRow } from './repo-runs.ts';

/** Reserves the handle: the requested one, or the org slug's default with `2`, `3` on a collision. */
export async function stepHandle(ctx: ServiceContext, runId: string): Promise<string> {
  const { run, ref } = await beginStep(ctx, runId, 'handle');
  const db = ctx.env.DB;
  const org = await getOrgRow(db, run.target_id);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  // One managed pass type per org: a handle it already holds is reused, whatever the slug is now.
  const held = await handleOfOrg(db, org.id);
  if (held) {
    if (ref.requestedHandle && ref.requestedHandle !== held)
      throw new ValidationError(
        'This organization already has a handle.',
        [],
        'IDENTITY_HANDLE_FIXED',
      );
    await patchRef(ctx, runId, { handle: held });
    return held;
  }
  const explicit = ref.requestedHandle;
  const base = explicit ?? handleBase(org.slug);
  if (!HANDLE_PATTERN.test(base))
    throw new ValidationError(
      'The handle needs 2 to 30 lowercase letters or digits.',
      [],
      'IDENTITY_HANDLE_INVALID',
    );
  if (RESERVED_HANDLES.has(base))
    throw new ValidationError(
      'This handle is reserved. Choose another.',
      [],
      'IDENTITY_HANDLE_RESERVED',
    );
  let chosen: string | undefined;
  for (const candidate of explicit ? [base] : handleCandidates(base)) {
    let owner = await handleOwner(db, candidate);
    if (!owner) {
      await reserveHandleRow(db, candidate, org.id, ctx.clock.now());
      owner = await handleOwner(db, candidate);
    }
    if (owner?.orgId === org.id) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen)
    throw new ConflictError('This handle is taken. Choose another.', 'IDENTITY_HANDLE_TAKEN');
  await patchRef(ctx, runId, { handle: chosen });
  ctx.log.info('identity.handle_reserved', { runId, orgId: org.id, handle: chosen });
  return chosen;
}
