import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';

/**
 * Whether an org's Test calls keep redacted bodies: a sandbox always does, any other org when an admin turned on
 * `requestLog.bodies`. Metadata (route, status, flags) is kept either way.
 */
export async function bodiesRecorded(
  ctx: ServiceContext,
  orgId: string,
  kind?: string,
): Promise<boolean> {
  const orgKind =
    kind ??
    (await first<{ kind: string }>(ctx.env.DB, 'SELECT kind FROM orgs WHERE id = ?', [orgId]))
      ?.kind;
  if (orgKind === 'developer') return true;
  return (await getOrgSettings(ctx, orgId))['requestLog.bodies'];
}
