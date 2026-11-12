import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from './redact.ts';
import type { AuditEntry } from './types.ts';

/**
 * An audit row that commits in its grant's batch and only while that grant row exists, so a mutation
 * and its audit record still commit together (or not at all). `when` narrows it over the state before
 * the batch's writes, for example "the key is not revoked yet"; add this statement before the write.
 * The row itself is built by `Grant.audit`; this only redacts and maps the entry.
 */
export function grantedAudit(
  g: Grant,
  ctx: Pick<ServiceContext, 'clock' | 'requestId'>,
  entry: AuditEntry,
  when?: GrantCond[],
): GrantedStatement {
  return g.audit(
    {
      at: ctx.clock.now(),
      orgId: entry.orgId ?? null,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      requestId: ctx.requestId,
      ipPrefix: entry.ipPrefix ?? null,
      detail: entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
    },
    when,
  );
}
