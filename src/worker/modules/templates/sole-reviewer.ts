import type { Mode } from '../../../shared/contracts/common.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ApprovalKind } from './repo-releases.ts';
import {
  countEligibleReviewers,
  lastReviewerRemoval,
  SOLE_COOLDOWN_MS,
} from './repo-sole-reviewer.ts';

const DENIED = 'TEMPLATE_SELF_APPROVAL';

/**
 * How an approval by `reviewerId` is recorded. An independent reviewer is `peer`. The author's own
 * approval needs the caller's explicit `alone` and either Test mode (any org) or an org whose only
 * eligible reviewer (an active member with `templates:review`) is the author, with no reviewer
 * removed in the last 7 days. The grant counts again at commit, so a reviewer added meanwhile wins.
 */
export async function approvalKind(
  ctx: ServiceContext,
  input: {
    orgId: string;
    mode: Mode;
    selfAuthored: boolean;
    alone: boolean | undefined;
  },
): Promise<ApprovalKind> {
  if (!input.selfAuthored) return 'peer';
  if (input.mode === 'test') {
    if (input.alone !== true)
      throw new ForbiddenError(
        'You wrote this version. Confirm to approve it alone in Test, or ask another reviewer.',
        DENIED,
      );
    return 'test';
  }
  const db = ctx.env.DB;
  if ((await countEligibleReviewers(db, input.orgId)) !== 1)
    throw new ForbiddenError(
      'You wrote this version. Another reviewer must approve it: invite one from Members.',
      DENIED,
    );
  const removed = await lastReviewerRemoval(db, input.orgId);
  if (removed !== null && removed > ctx.clock.now() - SOLE_COOLDOWN_MS)
    throw new ForbiddenError(
      'A reviewer was removed in the last 7 days. Another reviewer must approve this version.',
      DENIED,
    );
  if (input.alone !== true)
    throw new ForbiddenError(
      'No one else can review in this organization. Confirm to approve it yourself.',
      DENIED,
    );
  return 'sole';
}
