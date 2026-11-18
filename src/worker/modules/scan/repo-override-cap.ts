import { bumpIfStmt, claim } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScanActor } from './guard.ts';

/** Overrides and Mark-as-outs one device or person makes in an hour (SA §20.12). */
export const OVERRIDE_CAP = 120;
const HOUR = 3_600_000;

/**
 * Counts one override or mark-out against `scan:ovr:<actorKey>`. Past the cap nothing more is counted,
 * the answer is 429, and the first refusal of the hour is audited once.
 */
export async function countOverride(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  const key = `scan:ovr:${actor.actorKey}`;
  const row = await bumpIfStmt(ctx.env.DB, key, window, {
    sql: 'COALESCE((SELECT count FROM counters WHERE key = ? AND window_start = ?), 0) < ?',
    params: [key, window, OVERRIDE_CAP],
  }).first<{ count: number }>();
  if (row) return;
  if (await claim(ctx.env.DB, `scan:ovr:capped:${actor.actorKey}`, window))
    await auditStmt(ctx.env.DB, ctx, {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.overrides_capped',
      detail: { cap: OVERRIDE_CAP },
    }).run();
  throw new AppError('SCAN_TOO_MANY_OVERRIDES', 429, 'Too many overrides this hour. Wait a bit.', {
    headers: { 'retry-after': String(Math.ceil((window + HOUR - now) / 1000)) },
  });
}
