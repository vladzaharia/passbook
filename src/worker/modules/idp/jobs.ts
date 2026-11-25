import { countQueries } from '../../jobs/query-counter.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from './client.ts';
import { drainSubject } from './drain.ts';
import { idpCodeOf } from './errors.ts';
import { reconcile } from './reconcile.ts';
import { clearDirty, dueDirty, failDirty, markDirty } from './repo-dirty.ts';
import { markClaimSwept, unsettledClaims } from './repo-invite-claims.ts';
import type { RunEnv } from './run-env.ts';
import type { IdpRpc } from './types.ts';

/** Subjects one minute run takes (design 1 section 3.4). */
export const DRAIN_BATCH = 20;
/** The minute hooks share one invocation's 1,000 D1 queries: the drain stops starting subjects past this. */
export const DRAIN_QUERY_CAP = 250;
/** The daily hooks share 900: the reconcile stops verifying past this many of its own. */
export const RECONCILE_QUERY_CAP = 300;
const SWEEP_LIMIT = 20;

type Gate = Pick<RunEnv, 'dry' | 'blocked'>;

/**
 * One health read per run. Polaris ID unreachable, frozen or unsafe ends the run before any change is
 * attempted; marks stay due. `dry` is Polaris ID's mode: a dry run changes nothing in PassBook either.
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

/**
 * Existing-account claims whose window ended unaccepted, or whose invitation was revoked: their reason is gone
 * from the desired state, so marking the subject lets the drain take back what the claim gave.
 */
async function sweepClaims(db: D1Database, now: number): Promise<void> {
  for (const claim of await unsettledClaims(db, now, SWEEP_LIMIT)) {
    await markDirty(db, claim.subject);
    await markClaimSwept(db, claim.id, now);
  }
}

/**
 * Minute hook `idp.drain`: up to 20 due subjects, oldest due first, one `apply` each at most. A breaker, a
 * freeze or a spent budget stops the run; a failed subject backs off (1 m, 5 m, 30 m, 6 h); a mark that
 * arrived meanwhile stays due. With nothing due, or no binding, it costs one query and no call.
 */
export async function drainIdp(ctx: ServiceContext, cap = DRAIN_QUERY_CAP): Promise<void> {
  if (!idpConfigured(ctx.env)) return;
  const counter = countQueries(ctx.env);
  const counted: ServiceContext = { ...ctx, env: counter.env };
  const db = counter.env.DB;
  await sweepClaims(db, ctx.clock.now());
  const due = await dueDirty(db, ctx.clock.now(), DRAIN_BATCH);
  if (due.length === 0) return;
  const rpc = idpClient(counter.env, ctx.log);
  const gate = await openGate(ctx, rpc, 'idp.drain');
  if (!gate) return;
  const env: RunEnv = { ctx: counted, rpc, runId: ctx.ids.id(), ...gate };
  for (const [i, row] of due.entries()) {
    if (counter.count() >= cap) {
      ctx.log.warn('idp.drain.capped', {
        code: 'CRON_BUDGET',
        queries: counter.count(),
        left: due.length - i,
      });
      return;
    }
    const outcome = await drainSubject(env, row);
    if (outcome.mark === 'clear') await clearDirty(db, row.subject, row.version);
    else if (outcome.mark === 'fail')
      await failDirty(db, row.subject, row.version, ctx.clock.now());
    if (outcome.stop) {
      ctx.log.warn('idp.drain.stopped', { code: 'IDP_RUN_STOPPED', left: due.length - i - 1 });
      return;
    }
  }
}

/**
 * Daily hook `idp.reconcile` (also behind Check now): one snapshot of every group, classified with the same
 * table as the drain. Starts only while the daily hooks have query budget left.
 */
export async function reconcileIdp(ctx: ServiceContext, cap = RECONCILE_QUERY_CAP): Promise<void> {
  if (!idpConfigured(ctx.env)) return;
  const counter = countQueries(ctx.env);
  const counted: ServiceContext = { ...ctx, env: counter.env };
  const rpc = idpClient(counter.env, ctx.log);
  const gate = await openGate(ctx, rpc, 'idp.reconcile');
  if (!gate) return;
  const env: RunEnv = { ctx: counted, rpc, runId: ctx.ids.id(), ...gate };
  await reconcile(env, counter.count, cap);
}
