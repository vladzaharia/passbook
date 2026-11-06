import { bump } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScanActor } from './guard.ts';

const WINDOW_MS = 10 * 60_000;
export const MISSES_PER_WINDOW = 30;

/**
 * Counts a `not_found` from any method (SA 2.9). Past the cap the actor gets 429
 * SCAN_TOO_MANY_MISSES until the window ends; the audit row is written once per window.
 */
export async function countMiss(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  const now = ctx.clock.now();
  const window = now - (now % WINDOW_MS);
  const n = await bump(ctx.env.DB, `scan:miss:${actor.actorKey}`, window);
  if (n <= MISSES_PER_WINDOW) return;
  if (n === MISSES_PER_WINDOW + 1)
    await auditStmt(ctx.env.DB, ctx, {
      orgId: actor.orgId,
      actorType: actor.actor.type === 'scanner' ? 'scanner' : 'user',
      actorId: actor.actor.id,
      action: 'scan.misses_capped',
      targetType: actor.scanner ? 'scanner' : undefined,
      targetId: actor.scanner?.id,
    }).run();
  throw new AppError('SCAN_TOO_MANY_MISSES', 429, 'Too many codes not found. Wait a few minutes.', {
    headers: { 'retry-after': String(Math.ceil((window + WINDOW_MS - now) / 1000)) },
  });
}
