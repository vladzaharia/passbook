import { BUNDLE_MAX_PASSES } from '../../../shared/contracts/bundles.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';

/** Every pass must be in the org and in the caller's mode, or the bundle is refused. */
export async function checkPasses(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  passIds: string[],
): Promise<Pass[]> {
  if (new Set(passIds).size !== passIds.length)
    throw new ValidationError('A pass is listed twice.', [], 'BUNDLE_DUPLICATE_PASS');
  if (passIds.length > BUNDLE_MAX_PASSES)
    throw new ValidationError('A bundle holds at most 10 passes.', [], 'BUNDLE_TOO_MANY');
  const passes = await Promise.all(passIds.map((id) => getPass(ctx.env.DB, id, orgId)));
  if (passes.some((p) => !p)) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (passes.some((p) => p?.mode !== mode))
    throw new ValidationError(
      `A ${mode} bundle holds ${mode} passes only.`,
      [],
      'BUNDLE_MODE_MISMATCH',
    );
  return passes.filter((pass): pass is Pass => pass !== null);
}
