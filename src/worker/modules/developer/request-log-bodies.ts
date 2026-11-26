import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { orgKindOf } from './repo-request-log.ts';

/**
 * Whether an org's Test calls keep redacted bodies: a sandbox always does, any other org when an admin turned on
 * `requestLog.bodies`. Metadata (route, status, flags) is kept either way.
 */
export async function bodiesRecorded(
  ctx: ServiceContext,
  orgId: string,
  kind?: string,
): Promise<boolean> {
  const orgKind = kind ?? (await orgKindOf(ctx.env.DB, orgId));
  if (orgKind === 'developer') return true;
  return (await getOrgSettings(ctx, orgId))['requestLog.bodies'];
}
