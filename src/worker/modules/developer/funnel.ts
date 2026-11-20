import catalog from '../../../../docs/api/errors.json' with { type: 'json' };
import type { QuickstartBeacon } from '../../../shared/contracts/developer.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sandboxOfUser } from './repo.ts';
import { firstCallAt, firstPassAt, funnelOf, hasUpdatedPass } from './repo-funnel.ts';
import { type FunnelColumn, stampFunnel } from './repo-grants.ts';

const DAY_MS = 86_400_000;

/**
 * The browser's page-view time, held to the last 24 hours and never after now: a stale tab or a wrong clock cannot
 * stretch the time to first pass past a day, or run it backwards.
 */
export const clampViewedAt = (viewedAt: number, now: number): number =>
  Math.min(now, Math.max(viewedAt, now - DAY_MS));

const KNOWN_CODES: ReadonlySet<string> = new Set(catalog.codes.map((c) => c.code));

/** A problem code the catalog knows, else `OTHER`: a person cannot mint outcome values by posting their own. */
const knownCode = (code: string | undefined): string =>
  code !== undefined && KNOWN_CODES.has(code) ? code : 'OTHER';

/** Steps with no column to gate them: at most 3 a minute per org and step reach the events. */
const repeatable = (ctx: ServiceContext, orgId: string, step: string): Promise<boolean> =>
  checkRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:dev-beacon:${orgId}:${step}`);

/**
 * The sandbox's funnel events carry the org id and nothing else: no person, pass, key or address. A step the
 * page reports is a claim: the columns are stamped from what the database holds, so a script cannot invent a pass,
 * and an event is written only when its stamp landed (set-once steps) or the database shows the step happened
 * (`change`, `home`), so replaying a beacon adds nothing. `first_call_at` is stamped on the first funnel event after
 * a call exists and never moves, so the request log's 7-day purge cannot make it later.
 */
export async function recordQuickstartStep(
  ctx: ServiceContext,
  auth: SessionAuth,
  beacon: QuickstartBeacon,
): Promise<void> {
  const db = ctx.env.DB;
  const sandbox = await sandboxOfUser(db, auth.userId);
  if (!sandbox || sandbox.closed_at !== null) return;
  const orgId = sandbox.org_id;
  const now = ctx.clock.now();
  const by = { userId: auth.userId, sessionIdHash: auth.sessionId };
  const before = await funnelOf(db, orgId);
  const stamps: Partial<Record<FunnelColumn, number>> = {};
  const { step } = beacon;
  if (step === 'view' && before?.quickstart_viewed_at == null) stamps.quickstart_viewed_at = now;
  if (before?.first_call_at == null) {
    const call = await firstCallAt(db, orgId);
    if (call !== null) stamps.first_call_at = call;
  }
  // `run` and `live` may arrive in either order (two keepalive requests): both look for the pass.
  let passAt = before?.first_pass_at ?? null;
  if ((step === 'run' || step === 'live') && passAt === null) {
    passAt = await firstPassAt(db, orgId);
    if (passAt !== null) stamps.first_pass_at = passAt;
  }
  if (step === 'live' && passAt !== null && before?.first_preview_at == null)
    stamps.first_preview_at = now;
  const landed = await stampFunnel(ctx, orgId, by, stamps);

  const viewed = before?.quickstart_viewed_at ?? stamps.quickstart_viewed_at ?? null;
  // A pass older than the page view is not "time to first pass": it was made before the person came here.
  if (landed.has('first_pass_at') && viewed !== null && passAt !== null && passAt >= viewed)
    writeEvent(
      ctx.env,
      { event: 'dev.ttfp', orgId, mode: 'test', value: passAt - viewed },
      ctx.log,
    );

  const emit = (outcome?: string) =>
    writeEvent(
      ctx.env,
      { event: `dev.${step}`, orgId, mode: 'test', ...(outcome ? { outcome } : {}) },
      ctx.log,
    );
  if (step === 'view' || step === 'run' || step === 'live') {
    const column =
      step === 'view'
        ? 'quickstart_viewed_at'
        : step === 'run'
          ? 'first_pass_at'
          : 'first_preview_at';
    if (landed.has(column)) emit();
  } else if (step === 'change') {
    if ((await hasUpdatedPass(db, orgId)) && (await repeatable(ctx, orgId, step))) emit();
  } else if (step === 'home') {
    if (
      viewed !== null &&
      (before?.first_preview_at != null || landed.has('first_preview_at')) &&
      (await repeatable(ctx, orgId, step))
    )
      emit();
  } else if (step === 'fail') {
    if (await repeatable(ctx, orgId, step)) emit(knownCode(beacon.code));
  }
  // `sandbox` is written by recordSandboxMade, once, when the sandbox is made.
}

/** Sandbox create: the page-view time from the browser's session, stamped once, clamped; `fresh` is a sandbox just made. */
export async function recordSandboxMade(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  viewedAt: number | undefined,
  fresh: boolean,
): Promise<void> {
  const now = ctx.clock.now();
  if (viewedAt !== undefined)
    await stampFunnel(
      ctx,
      orgId,
      { userId: auth.userId, sessionIdHash: auth.sessionId },
      { quickstart_viewed_at: clampViewedAt(viewedAt, now) },
    );
  // A retry or a repair finds the sandbox made: no second `dev.sandbox`.
  if (fresh) writeEvent(ctx.env, { event: 'dev.sandbox', orgId, mode: 'test' }, ctx.log);
}
