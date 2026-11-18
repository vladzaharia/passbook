import { bumpIfStmt, claim } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';

/** Overrides and Mark-as-outs one device or person makes in an hour (SA §20.12). */
export const OVERRIDE_CAP = 120;
const HOUR = 3_600_000;

export interface CapActor {
  orgId: string;
  actorKey: string;
  actor: { type: 'scanner' | 'user'; id: string };
}

const windowOf = (ctx: ServiceContext) => {
  const now = ctx.clock.now();
  return { now, window: now - (now % HOUR) };
};

/**
 * Refuses when the hour's cap is spent: 429, and the first refusal of the hour is audited once. Counts
 * nothing; `countOverride` does that once the action succeeded, so a held answer or a retry costs no slot.
 */
export async function assertUnderOverrideCap(ctx: ServiceContext, a: CapActor): Promise<void> {
  const { now, window } = windowOf(ctx);
  const row = await ctx.env.DB.prepare(
    'SELECT count FROM counters WHERE key = ? AND window_start = ?',
  )
    .bind(`scan:ovr:${a.actorKey}`, window)
    .first<{ count: number }>();
  if ((row?.count ?? 0) < OVERRIDE_CAP) return;
  if (await claim(ctx.env.DB, `scan:ovr:capped:${a.actorKey}`, window))
    await auditStmt(ctx.env.DB, ctx, {
      orgId: a.orgId,
      actorType: a.actor.type,
      actorId: a.actor.id,
      action: 'scan.overrides_capped',
      detail: { cap: OVERRIDE_CAP },
    }).run();
  throw new AppError('SCAN_TOO_MANY_OVERRIDES', 429, 'Too many overrides this hour. Wait a bit.', {
    headers: { 'retry-after': String(Math.ceil((window + HOUR - now) / 1000)) },
  });
}

/** One override or mark-out done. */
export async function countOverride(ctx: ServiceContext, a: CapActor): Promise<void> {
  const { window } = windowOf(ctx);
  await bumpIfStmt(ctx.env.DB, `scan:ovr:${a.actorKey}`, window, { sql: '1', params: [] }).run();
}
