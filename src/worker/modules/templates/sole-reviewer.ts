import type { Mode } from '../../../shared/contracts/common.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ApprovalKind } from './repo-releases.ts';
import { countEligibleReviewers } from './repo-sole-reviewer.ts';

/**
 * How an approval by the caller is recorded, for every provider. An independent reviewer is `peer`.
 * The author's own approval needs the caller's explicit `alone` and either Test mode (Apple only) or
 * an org whose only eligible reviewer (an active member with `templates:review`) is the author:
 * a personal, sandbox or one-member org. The count is taken again at commit, and a reviewer added
 * before release voids an unreleased `sole` approval. An API key acts as its creator's membership.
 */
export async function approvalKind(
  ctx: ServiceContext,
  input: {
    orgId: string;
    mode: Mode;
    selfAuthored: boolean;
    alone: boolean | undefined;
    /** Test-mode self-approval is an Apple rule; a wallet class goes through the sole rule. */
    provider?: 'apple' | 'google' | 'samsung';
  },
): Promise<ApprovalKind> {
  if (!input.selfAuthored) return 'peer';
  if (input.mode === 'test' && (input.provider ?? 'apple') === 'apple') {
    if (input.alone !== true)
      throw new ForbiddenError(
        'You wrote this version. Confirm to approve it alone in Test, or ask another reviewer.',
        'TEMPLATE_SELF_APPROVAL',
      );
    return 'test';
  }
  if ((await countEligibleReviewers(ctx.env.DB, input.orgId)) !== 1)
    throw new ForbiddenError(
      'You wrote this version. Another reviewer must approve it: invite one from Members.',
      'TEMPLATE_SELF_APPROVAL',
    );
  if (input.alone !== true)
    throw new ForbiddenError(
      'No one else can review in this organization. Confirm to approve it yourself.',
      'TEMPLATE_SELF_APPROVAL',
    );
  return 'sole';
}
