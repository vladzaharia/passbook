import {
  sameTimedKeys,
  type TimedKeys,
  timedKeysOf,
} from '../../../passkit/behaviors/upcoming-events/timed.ts';
import { nextBoundary, passBoundaries } from '../../../passkit/boundaries.ts';
import type { PassJson, Personalization } from '../../../passkit/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { resolveTemplate } from './builder.ts';
import {
  BOUNDARY_LEASE_MS,
  type BoundaryClaim,
  type BoundaryWork,
  claimDueBoundaries,
  dropBoundary,
  moveBoundary,
  readBoundaryWork,
} from './repo-boundaries.ts';
import { stampBoundary } from './repo-boundary-stamp.ts';
import { eventMinutes, eventsConfig, timedPassJson } from './timed-pass.ts';

const MINUTE = 60_000;
/** Renders of one pass are at least this far apart; boundaries closer together share one. */
export const BOUNDARY_FLOOR_MS = 5 * MINUTE;
/** The cron's and the job's clocks differ a little: a boundary this close counts as passed. */
export const BOUNDARY_SKEW_MS = 5_000;
const BACKOFF_MS = MINUTE;
const BACKOFF_CAP_MS = 60 * MINUTE;
/** Queues take at most 100 messages a call. */
const SEND_BATCH = 100;

/**
 * Minute hook: claims the passes whose next event start or end has passed and queues one job each,
 * so each runs in its own invocation with its own query budget and queue retries. One query a tick.
 */
export async function claimBoundaries(ctx: ServiceContext): Promise<void> {
  const settings = await getPlatformSettings(ctx);
  const now = ctx.clock.now();
  const lease = now + BOUNDARY_LEASE_MS;
  const ids = await claimDueBoundaries(ctx.env.DB, {
    now,
    lease,
    limit: settings['passes.boundaryClaim'],
    perOrg: settings['passes.boundaryOrgShare'],
  });
  if (ids.length === 0) return;
  try {
    for (let i = 0; i < ids.length; i += SEND_BATCH)
      await ctx.env.JOBS.sendBatch(
        ids
          .slice(i, i + SEND_BATCH)
          .map((passId) => ({ body: { kind: 'pass.boundary_refresh' as const, passId, lease } })),
      );
  } catch (error) {
    // The claimed rows come back when their lease ends.
    ctx.log.error('pass.boundary_enqueue_failed', { code: 'BOUNDARY_ENQUEUE', error });
    return;
  }
  ctx.log.info('pass.boundaries_claimed', { count: ids.length });
}

/** A refusal retrying cannot fix: the row is retired. Conflicts and limits retry with a backoff. */
const permanent = (error: unknown) =>
  error instanceof AppError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 409 &&
  error.status !== 429;

/**
 * Queue job: works out the timed keys of the pass's artifact at the current time. When they moved, the
 * render is stored with a new update tag and a push, so devices fetch it; no version is made. Then the
 * row waits for the next start or end. A failure never throws past one pass: it backs off, or retires
 * the row when retrying cannot help.
 */
export async function handleBoundaryRefresh(
  job: JobOf<'pass.boundary_refresh'>,
  ctx: ServiceContext,
): Promise<void> {
  const work = await readBoundaryWork(ctx.env.DB, job.passId);
  // A new artifact or a later claim took the row over.
  if (!work || work.dueAt !== job.lease) return;
  const claim = { passId: job.passId, objectKey: work.objectKey, lease: job.lease };
  try {
    await refresh(ctx, work, claim);
  } catch (error) {
    await failed(ctx, work, claim, error);
  }
}

async function refresh(ctx: ServiceContext, work: BoundaryWork, claim: BoundaryClaim) {
  const db = ctx.env.DB;
  const p = work.pass;
  const live =
    p.status === 'active' && p.removedAt === null && p.deletedAt === null && !p.quarantined;
  // A voided, removed or deleted pass stays as it was; a pass on another artifact has its own row.
  if (!live || p.objectKey !== work.objectKey || work.passJson === null) {
    await dropBoundary(db, claim);
    return;
  }
  const template = await resolveTemplate(ctx, p.orgId, p.templateId, p.templateVersion);
  // Events written by a binding alone do not move with the clock.
  if (!eventsConfig(template)) {
    await dropBoundary(db, claim);
    return;
  }
  const built = JSON.parse(work.passJson) as PassJson;
  const personalization = JSON.parse(p.personalization) as Personalization;
  const at = ctx.clock.now() + BOUNDARY_SKEW_MS;
  let rendered: PassJson;
  try {
    rendered = timedPassJson(built, personalization, template, at);
  } catch (error) {
    // The behavior refuses the inputs now (a later code change): retrying cannot help.
    await retire(ctx, work, claim, 'BOUNDARY_RENDER_INVALID', error);
    return;
  }
  const keys = timedKeysOf(rendered);
  const shown = work.render === null ? timedKeysOf(built) : (JSON.parse(work.render) as TimedKeys);
  const fallbackMinutes = eventMinutes(template);
  const upcoming = nextBoundary(passBoundaries(rendered, { fallbackMinutes }), at);
  const now = ctx.clock.now();
  if (sameTimedKeys(keys, shown)) {
    // Nothing moved: an event past the cap started, or the boundary is a second run's.
    const floor = work.stampedAt > 0 ? work.stampedAt + BOUNDARY_FLOOR_MS : 0;
    const due = upcoming === null ? null : Math.max(upcoming, floor);
    if (due === null && work.renderedAt === 0) await dropBoundary(db, claim);
    else await moveBoundary(db, claim, due);
    return;
  }
  const outcome = await stampBoundary(
    ctx,
    claim,
    p,
    {
      renderedAt: at,
      render: JSON.stringify(keys),
      dueAt: upcoming === null ? null : Math.max(upcoming, now + BOUNDARY_FLOOR_MS),
      now,
    },
    `push:${claim.passId}:boundary:${ctx.ids.id()}`,
  );
  if (outcome === 'stamped') await dispatchSafely(ctx, { passId: claim.passId });
  else if (outcome === 'refused') await backoff(ctx, work, claim, 'BOUNDARY_REFUSED');
}

async function backoff(
  ctx: ServiceContext,
  work: BoundaryWork,
  claim: BoundaryClaim,
  code: string,
) {
  const attempts = work.attempts + 1;
  const delay = Math.min(BACKOFF_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  // A new artifact took the row over (a refusal from a lost claim): nothing waits, nothing to log.
  if (!(await moveBoundary(ctx.env.DB, claim, ctx.clock.now() + delay, attempts))) return;
  ctx.log.warn('pass.boundary_backoff', {
    orgId: work.pass.orgId,
    passId: claim.passId,
    code,
    attempts,
  });
}

async function failed(
  ctx: ServiceContext,
  work: BoundaryWork,
  claim: BoundaryClaim,
  error: unknown,
) {
  const code = error instanceof AppError ? error.code : 'BOUNDARY_REFRESH_FAILED';
  if (!permanent(error)) {
    ctx.log.error('pass.boundary_refresh_failed', {
      orgId: work.pass.orgId,
      passId: claim.passId,
      code,
      error,
    });
    await backoff(ctx, work, claim, code);
    return;
  }
  await retire(ctx, work, claim, code);
}

async function retire(
  ctx: ServiceContext,
  work: BoundaryWork,
  claim: BoundaryClaim,
  code: string,
  error?: unknown,
) {
  ctx.log.error('pass.boundary_retired', {
    orgId: work.pass.orgId,
    passId: claim.passId,
    code,
    ...(error ? { error } : {}),
  });
  // A render already made keeps serving; the row is only no longer worked.
  if (work.renderedAt === 0) await dropBoundary(ctx.env.DB, claim);
  else await moveBoundary(ctx.env.DB, claim, null);
}
