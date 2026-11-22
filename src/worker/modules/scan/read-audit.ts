import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmtWhere } from '../audit/repo.ts';
import type { ScanActor } from './actor.ts';

/** A desk opens a person's history and notes together; the two reads are one audit row per window. */
const READ_WINDOW_MS = 60_000;

/**
 * Audits one read of a pass's history or notes: the count, no content. Skipped when the same actor already
 * left a history or notes read row for the pass in the last minute.
 */
export async function auditPassRead(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  action: 'scan.history.read' | 'scan.note.read',
  count: number,
): Promise<void> {
  await auditStmtWhere(
    ctx.env.DB,
    ctx,
    {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action,
      targetType: 'pass',
      targetId: passId,
      detail: { count },
    },
    `NOT EXISTS (SELECT 1 FROM audit_log WHERE org_id = ? AND actor_type = ? AND actor_id IS ? AND target_id = ?
       AND action IN ('scan.history.read', 'scan.note.read') AND at > ?)`,
    [
      actor.orgId,
      actor.actor.type,
      actor.actor.id ?? null,
      passId,
      ctx.clock.now() - READ_WINDOW_MS,
    ],
  ).run();
}
