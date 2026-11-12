import { run } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import { recordAudit } from '../audit/service.ts';
import type { AuditEntry } from '../audit/types.ts';
import { type ConnectionAuthority, connectionAuthPredicate } from './access.ts';

/** Audit tenant actions under the same live authority as their other writes. */
export async function recordConnectionAudit(
  sctx: ServiceContext,
  entry: AuditEntry & { orgId: string },
  authority?: ConnectionAuthority,
): Promise<void> {
  if (!authority) return recordAudit(sctx, entry);
  const now = sctx.clock.now();
  const predicate = connectionAuthPredicate(authority, 'subject.org_id', now);
  const subject = entry.targetId
    ? '(SELECT org_id FROM connections WHERE id = ? AND org_id = ?) subject'
    : '(SELECT id AS org_id FROM orgs WHERE id = ?) subject';
  const result = await run(
    sctx.env.DB,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, subject.org_id, ?, ?, ?, ?, ?, ?, ?, ? FROM ${subject} WHERE ${predicate.sql}`,
    [
      now,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      sctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
      ...(entry.targetId ? [entry.targetId, entry.orgId] : [entry.orgId]),
      ...predicate.params,
    ],
  );
  if (result.changes !== 1) throw new ForbiddenError();
}
