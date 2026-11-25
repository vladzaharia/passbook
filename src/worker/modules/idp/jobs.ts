import { CRON_QUERY_BUDGET, countQueries } from '../../jobs/query-counter.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from './client.ts';
import { drainSubject } from './drain.ts';
import { idpCodeOf } from './errors.ts';
import { dueSweeps, sweepSetups } from './invitations/sweep.ts';
import { reconcile } from './reconcile.ts';
import { clearDirty, dueDirty, failDirty, markDirty } from './repo-dirty.ts';
import { markClaimSwept, unsettledClaims } from './repo-invite-claims.ts';
import { dropLease, renewLease, SYNC_LEASE, takeLease } from './repo-lease.ts';
import { deferDirty } from './repo-sync.ts';
import type { RunEnv } from './run-env.ts';
import type { IdpRpc } from './types.ts';

/** Subjects one minute run takes (design 1 section 3.4). */
export const DRAIN_BATCH = 20;
/** The minute hooks share one invocation's 1,000 D1 queries: the drain stops starting subjects past this. */
export const DRAIN_QUERY_CAP = 250;
/** Targets one minute run looks at: a subject with many groups costs more than one with one role. */
export const DRAIN_TARGET_CAP = 80;
/** The daily hooks share 900: the reconcile stops starting phases past this many of its own queries. */
export const RECONCILE_QUERY_CAP = 300;
/** A dry run looks at a mark again after this long, so a week of dry runs costs one look a day each. */
export const DRY_DEFER_MS = 86_400_000;
const SWEEP_LIMIT = 20;

type Gate = Pick<RunEnv, 'dry' | 'blocked'>;

/**
 * One health read per run. Polaris ID unreachable, frozen or unsafe ends the run before any change is
 * attempted; marks stay due. `dry` is Polaris ID's mode.
 *
 * A dry run records drift rows and nothing else: no observed state, error codes, hold, session change, sandbox
 * close, sponsorship settle, claim sweep or reconcile mark. Its marks stay, due again after `DRY_DEFER_MS`.
 */
async function openGate(ctx: ServiceContext, rpc: IdpRpc, job: string): Promise<Gate | null> {
  try {
    const health = await rpc.health();
    if (health.frozen || !health.ok || health.unsafe.length > 0) {
      ctx.log.warn(`${job}.not_ready`, {
        code: health.frozen ? 'IDP_FROZEN' : 'IDP_UNSAFE_CONFIG',
        unsafe: health.unsafe.length,
      });
      return null;
    }
    return { dry: health.mode !== 'live', blocked: new Set(health.blocked) };
  } catch (error) {
    ctx.log.warn(`${job}.unavailable`, { code: idpCodeOf(error) ?? 'IDP_UNAVAILABLE' });
    return null;
  }
}

/** How long a run that must not be starved waits for the lease, polling every `LEASE_POLL_MS`. */
export const LEASE_WAIT_MS = 90_000;
const LEASE_POLL_MS = 5_000;

/**
 * Runs `work` holding the shared lease, passing it a `renew` for after each subject. A run that finds the lease
 * taken skips (the next minute tries again), unless it may wait: the daily reconcile polls for up to
 * `waitMs`, so a drain that runs every minute cannot starve it.
 */
async function leased(
  ctx: ServiceContext,
  db: D1Database,
  job: string,
  work: (renew: () => Promise<void>) => Promise<void>,
  waitMs = 0,
): Promise<void> {
  const holder = ctx.ids.id();
  let waited = 0;
  while (!(await takeLease(db, SYNC_LEASE, holder, ctx.clock.now()))) {
    if (waited >= waitMs) {
      ctx.log.info(`${job}.busy`, { lease: SYNC_LEASE });
      return;
    }
    await (ctx.clock.sleep?.(LEASE_POLL_MS) ??
      new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS)));
    waited += LEASE_POLL_MS;
  }
  try {
    await work(async () => void (await renewLease(db, SYNC_LEASE, holder, ctx.clock.now())));
  } finally {
    await dropLease(db, SYNC_LEASE, holder);
  }
}

/**
 * Existing-account claims whose window ended unaccepted, or whose invitation was revoked or expired: their reason
 * is gone from the desired state, so marking the subject lets the drain take back what the claim gave.
 */
async function sweepClaims(
  db: D1Database,
  claims: Awaited<ReturnType<typeof unsettledClaims>>,
  now: number,
): Promise<void> {
  for (const claim of claims) {
    await markDirty(db, claim.subject);
    await markClaimSwept(db, claim.id, now);
  }
}

/**
 * Minute hook `idp.drain`: up to 20 due subjects, oldest due first, one `apply` each at most. A breaker, a
 * freeze or a spent budget stops the run; a failed subject backs off (1 m, 5 m, 30 m, 6 h); a mark that
 * arrived meanwhile stays due. With nothing due, or no binding, it costs a query or two and no call. It never
 * overlaps another sync run (the `idp-sync` lease).
 */
export async function drainIdp(
  ctx: ServiceContext,
  cap = DRAIN_QUERY_CAP,
  targetCap = DRAIN_TARGET_CAP,
): Promise<void> {
  if (!idpConfigured(ctx.env)) return;
  const counter = countQueries(ctx.env);
  const counted: ServiceContext = { ...ctx, env: counter.env };
  const db = counter.env.DB;
  const claims = await unsettledClaims(db, ctx.clock.now(), SWEEP_LIMIT);
  const swept = await dueSweeps({ ...ctx, env: counter.env }, SWEEP_LIMIT);
  if (
    claims.length === 0 &&
    swept.ended.length === 0 &&
    swept.tokens.length === 0 &&
    (await dueDirty(db, ctx.clock.now(), 1)).length === 0
  )
    return;
  await leased(ctx, db, 'idp.drain', async (renew) => {
    const rpc = idpClient(counter.env, ctx.log);
    const gate = await openGate(ctx, rpc, 'idp.drain');
    if (!gate) return;
    if (!gate.dry) {
      await sweepClaims(db, claims, ctx.clock.now());
      await sweepSetups(counted, rpc, swept);
    }
    const due = await dueDirty(db, ctx.clock.now(), DRAIN_BATCH);
    const env: RunEnv = {
      ctx: counted,
      rpc,
      runId: ctx.ids.id(),
      ...gate,
      renew,
    };
    let targets = 0;
    for (const [i, row] of due.entries()) {
      if (counter.count() >= cap || targets >= targetCap) {
        ctx.log.warn('idp.drain.capped', {
          code: 'CRON_BUDGET',
          queries: counter.count(),
          targets,
          left: due.length - i,
        });
        return;
      }
      const outcome = await drainSubject(env, row);
      await renew();
      targets += outcome.targets;
      if (outcome.mark === 'clear') {
        if (gate.dry)
          await deferDirty(db, row.subject, row.version, ctx.clock.now() + DRY_DEFER_MS);
        else await clearDirty(db, row.subject, row.version);
      } else if (outcome.mark === 'fail')
        await failDirty(db, row.subject, row.version, ctx.clock.now());
      if (outcome.stop) {
        ctx.log.warn('idp.drain.stopped', { code: 'IDP_RUN_STOPPED', left: due.length - i - 1 });
        return;
      }
    }
  });
}

/**
 * Daily hook `idp.reconcile` (also behind Check now): one snapshot of every group, classified with the same
 * table as the drain. Its query cap is what is left of the shared daily budget, and at most `cap`.
 */
export async function reconcileIdp(ctx: ServiceContext, cap = RECONCILE_QUERY_CAP): Promise<void> {
  if (!idpConfigured(ctx.env)) return;
  const left = CRON_QUERY_BUDGET - (ctx.spent?.() ?? 0);
  const limit = Math.min(cap, left);
  if (limit <= 0) {
    ctx.log.warn('idp.reconcile.capped', { code: 'CRON_BUDGET', phase: 'start', left });
    return;
  }
  const counter = countQueries(ctx.env);
  const counted: ServiceContext = { ...ctx, env: counter.env };
  await leased(
    ctx,
    counter.env.DB,
    'idp.reconcile',
    async (renew) => {
      const rpc = idpClient(counter.env, ctx.log);
      const gate = await openGate(ctx, rpc, 'idp.reconcile');
      if (!gate) return;
      const env: RunEnv = {
        ctx: counted,
        rpc,
        runId: ctx.ids.id(),
        ...gate,
        renew,
      };
      await reconcile(env, counter.count, limit);
    },
    LEASE_WAIT_MS,
  );
}
