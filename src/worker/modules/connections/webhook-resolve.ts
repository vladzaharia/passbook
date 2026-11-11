import type { Actor } from '../../platform/context.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { summarizeItems } from './repo-webhook-items.ts';
import { resolveUncertainItems } from './repo-webhook-resolve.ts';
import { retainedById } from './repo-webhook-retention.ts';

/**
 * The operator checked the source system for a chunk whose effect is unknown and confirms it. The
 * uncertain items stop fencing their passes; a finished chunk can no longer be replayed.
 */
export async function resolveUncertainWebhook(
  sctx: ServiceContext,
  actor: Actor,
  connectionId: string,
  id: string,
  authority: ConnectionAuthority,
): Promise<{ resolved: number; state: 'failed' | 'blocked' | 'resolved' }> {
  const row = await retainedById(sctx.env.DB, connectionId, id);
  if (!row) throw new NotFoundError('Webhook work not found.', 'WEBHOOK_NOT_FOUND');
  if (authority.orgId !== row.orgId || authority.mode !== 'live') throw new ForbiddenError();
  await assertConnectionAuthority(sctx, authority);
  if (row.state === 'resolved' || row.state === 'ignored') {
    throw new ConflictError('This webhook work is already finished.', 'WEBHOOK_ALREADY_FINISHED');
  }
  if (row.state === 'pending') {
    throw new ConflictError('This webhook work is still queued.', 'WEBHOOK_STILL_PENDING');
  }
  const summary = await summarizeItems(sctx.env.DB, row);
  if (summary?.started) {
    throw new ConflictError('A webhook item may still be running.', 'WEBHOOK_EFFECT_UNCERTAIN');
  }
  if (!summary?.uncertain) {
    throw new ConflictError('No uncertain webhook items to resolve.', 'WEBHOOK_NOTHING_TO_RESOLVE');
  }
  const result = await resolveUncertainItems(sctx, row, {
    authority,
    now: sctx.clock.now(),
    requestId: sctx.requestId,
    actorType: actor.type,
    actorId: actor.id,
  });
  if (result.resolved === 0) {
    await assertConnectionAuthority(sctx, authority);
    throw new ConflictError('The webhook changed. Reload and retry.', 'WEBHOOK_RESOLVE_CONFLICT');
  }
  return {
    resolved: result.resolved,
    state: result.closed ? 'resolved' : row.state,
  };
}
