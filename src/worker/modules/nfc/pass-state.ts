import { validityOf } from '../../../shared/pass-view/validity.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type Candidate, candidateById } from '../scan/repo-lookup.ts';
import { candidateWallet } from '../scan/resolve-candidates.ts';
import { tagFit } from '../scan/tag-assurance.ts';

const refused = (reason: 'removed' | 'voided' | 'expired') =>
  new ConflictError(`Can't assign a tag to a ${reason} pass.`, `TAG_PASS_${reason.toUpperCase()}`);

/** A Basic tag cannot go to a pass whose template needs a secure one. */
export function assertTakesTag(ctx: ServiceContext, candidate: Candidate): void {
  const fit = tagFit(ctx, candidate);
  if (fit === 'unreadable') throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (fit === 'low') throw new ConflictError('This pass needs a secure tag.', 'TAG_ASSURANCE_LOW');
}

/** `assertTakesTag` for a pass id. A pass with no scan release cannot be admitted by any tag, so it passes. */
export async function assertPassTakesTag(
  ctx: ServiceContext,
  orgId: string,
  passId: string,
): Promise<void> {
  const candidate = await candidateById(ctx.env.DB, orgId, passId);
  if (candidate) assertTakesTag(ctx, candidate);
}

/** A tag goes to a pass that works: not removed, voided or expired (the refusals a scanner assign makes). */
export async function assertBindable(
  ctx: ServiceContext,
  orgId: string,
  passId: string,
): Promise<void> {
  const candidate = await candidateById(ctx.env.DB, orgId, passId);
  if (!candidate) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const { pass } = candidate;
  if (pass.removedAt !== null) throw refused('removed');
  if (pass.status === 'voided') throw refused('voided');
  const wallet = candidateWallet(candidate);
  if (!wallet) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const validity = validityOf(wallet, ctx.clock.now());
  if (validity.status === 'voided') throw refused('voided');
  if (validity.status === 'expired') throw refused('expired');
  assertTakesTag(ctx, candidate);
}
