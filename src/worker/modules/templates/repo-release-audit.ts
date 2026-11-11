import { stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';

/** Record an event only when the corresponding conditional insert actually succeeded. */
export function releaseAuditStmt(
  db: D1Database,
  ctx: ServiceContext,
  entity: 'candidate' | 'approval' | 'release',
  entityId: string,
  orgId: string,
  userId: string,
  templateId: string,
  action: string,
  detail: Record<string, unknown>,
): D1PreparedStatement {
  const table = {
    candidate: 'template_candidates',
    approval: 'template_approvals',
    release: 'template_releases',
  }[entity];
  return stmt(
    db,
    `INSERT INTO audit_log
       (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, 'user', ?, ?, 'template', ?, ?, NULL, ?
     WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
    [
      ctx.clock.now(),
      orgId,
      userId,
      action,
      templateId,
      ctx.requestId,
      JSON.stringify(redactDetail(detail)),
      entityId,
    ],
  );
}
