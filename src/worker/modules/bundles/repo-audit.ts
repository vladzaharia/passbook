import type { AuditEntry } from '../audit/types.ts';
import type { Actor } from '../passes/service.ts';

/** Recorded in the same batch as the queued mail, and only while its outbox row exists. */
export function bundleEmailAuditEntry(orgId: string, bundleId: string, actor: Actor): AuditEntry {
  return {
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'bundle.send_email',
    targetType: 'bundle',
    targetId: bundleId,
  };
}
