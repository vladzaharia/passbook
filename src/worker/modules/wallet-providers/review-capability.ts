import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';

/** Whether a signed-in person holds the template capability in the organization; a refusal is `false`, anything else throws. */
export async function holdsTemplateCapability(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: 'templates:review',
): Promise<boolean> {
  if (auth?.kind !== 'session') return false;
  try {
    await requireOrgCapability(ctx, auth.userId, orgId, capability);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
