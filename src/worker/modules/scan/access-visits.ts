import type { ScanVisitsReset } from '../../../shared/contracts/scan-access.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { ACCESS_GATE, passTarget } from './repo-access.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';

const CODES = { config: 'SCAN_PASS_CHANGED', lineage: 'SCAN_PASS_CHANGED' } as const;

/**
 * Reset an Access card's visits (AX 3.5): the gate row goes, so the next grant is the first.
 * Manager-equivalent (`scanning:manage`), audited; the pass must be in the session's org and mode.
 */
export async function resetVisits(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  authority: TenantPassWrite,
): Promise<ScanVisitsReset> {
  if (authority.kind !== 'session' || authority.capability !== 'scanning:manage')
    throw new ForbiddenError();
  const pass = await passTarget(ctx.env.DB, passId);
  if (!pass || pass.orgId !== authority.orgId || pass.mode !== authority.mode)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const g = adminGrant(
    ctx,
    'org_mode.scan.visits.reset',
    userId,
    authority,
    pass.orgId,
    [exactlyOne('passes', { id: passId }, undefined, 'config')],
    CODES,
    passId,
    ['scan_gates'],
  );
  g.delete('scan_gates', {
    where: { pass_id: passId, action_id: ACCESS_GATE, scope: ACCESS_GATE },
  });
  g.add(
    audited(g, ctx, {
      orgId: pass.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'pass.access_visits_reset',
      targetType: 'pass',
      targetId: passId,
    }),
  );
  await g.commit();
  return { passId, visits: 0 };
}
