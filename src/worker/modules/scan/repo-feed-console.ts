import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { audited, sessionGrant } from './repo-admin-grant.ts';

/** Audit an export in a grant, so it commits only while the tenant session and membership hold. */
export async function auditScanExport(
  ctx: ServiceContext,
  authority: Extract<TenantPassWrite, { kind: 'session' }>,
  detail: { from: number; to: number; rows: number },
): Promise<void> {
  const g = sessionGrant(ctx, 'org_mode.scan.export', authority);
  audited(g, ctx, {
    orgId: authority.orgId,
    actorType: 'user',
    actorId: authority.userId,
    action: 'scan.export',
    targetType: 'org',
    targetId: authority.orgId,
    detail,
  });
  await g.commit();
}
