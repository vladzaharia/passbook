import { nextBoundary, passBoundaries } from '../../../passkit/boundaries.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { resolveTemplate } from './builder.ts';
import { publishPass } from './publish.ts';
import {
  BOUNDARY_LEASE_MS,
  dropBoundary,
  dueBoundaries,
  latestPassJson,
  moveBoundary,
  unsettledBoundaries,
} from './repo-boundaries.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';

/** Passes handled per tick and step; the rest wait for the next minute. */
export const BOUNDARY_BATCH = 25;

/** A pass that can still change on its own: live, not removed from Wallet. */
async function livePass(ctx: ServiceContext, passId: string): Promise<Pass | null> {
  const pass = await getPass(ctx.env.DB, passId);
  if (pass?.status !== 'active' || pass.removedAt !== null) {
    await dropBoundary(ctx.env.DB, passId);
    return null;
  }
  return pass;
}

async function boundariesOf(ctx: ServiceContext, pass: Pass): Promise<number[]> {
  const raw = await latestPassJson(ctx.env.DB, pass.id);
  if (raw === null) return [];
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const events = template.manifest.behaviors?.find((b) => b.use === 'upcoming-events');
  const config = events?.config as { fallbackMinutes?: unknown } | undefined;
  const minutes = config?.fallbackMinutes;
  return passBoundaries(raw, typeof minutes === 'number' ? { fallbackMinutes: minutes } : {});
}

/**
 * A new version that lists events: its first boundary after it was built. One already behind us
 * (an old pass, or a version built just before one) is due now.
 */
async function settle(ctx: ServiceContext, passId: string): Promise<void> {
  const pass = await livePass(ctx, passId);
  if (!pass) return;
  const next = nextBoundary(await boundariesOf(ctx, pass), pass.modifiedAt);
  await moveBoundary(ctx.env.DB, passId, 0, next);
}

/** Rebuilds a pass whose boundary passed. True when it published a new version. */
async function rebuild(ctx: ServiceContext, passId: string, dueAt: number): Promise<boolean> {
  const db = ctx.env.DB;
  const pass = await livePass(ctx, passId);
  if (!pass) return false;
  // The lease keeps another tick off this pass; a new version resets the row and wins over it.
  const lease = ctx.clock.now() + BOUNDARY_LEASE_MS;
  if (!(await moveBoundary(db, passId, dueAt, lease))) return false;
  const published = await publishPass(ctx, {
    passId,
    orgScope: { orgId: pass.orgId, mode: pass.mode, principal: 'session' },
    cause: 'admin',
    source: 'schedule',
    sourceRef: 'event-boundary',
    actor: { type: 'system', id: null },
    dispatch: false,
    notify: false,
    mutate: () => ({}),
  });
  const next = nextBoundary(await boundariesOf(ctx, published.pass), ctx.clock.now());
  await moveBoundary(db, passId, lease, next);
  return published.changed;
}

/**
 * Minute hook. A pass that lists upcoming events has a `pass_boundaries` row; at its next start or end
 * the pass is rebuilt through the normal publish, so `isActive` and the next-event highlight move on
 * the device with no edit. A rebuild that changes nothing publishes and pushes nothing.
 */
export async function refreshAtBoundaries(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  for (const { passId } of await unsettledBoundaries(db, BOUNDARY_BATCH)) {
    try {
      await settle(ctx, passId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ctx.log.warn('pass.boundary_settle_failed', { passId, code: error.code });
    }
  }
  let changed = 0;
  let failed = 0;
  for (const { passId, dueAt } of await dueBoundaries(db, ctx.clock.now(), BOUNDARY_BATCH)) {
    try {
      if (await rebuild(ctx, passId, dueAt)) changed++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      failed++;
      ctx.log.warn('pass.boundary_refresh_failed', { passId, code: error.code });
    }
  }
  if (changed > 0) await dispatchSafely(ctx);
  if (changed + failed > 0) ctx.log.info('pass.boundary_refresh', { changed, failed });
}
