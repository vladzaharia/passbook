import type { QuickstartBeacon } from '../../../shared/contracts/developer.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sandboxOfUser } from './repo.ts';
import { firstCallAt, firstPassAt, funnelOf } from './repo-funnel.ts';
import { type FunnelColumn, stampFunnel } from './repo-grants.ts';

const DAY_MS = 86_400_000;

/**
 * The browser's page-view time, held to the last 24 hours and never after now: a stale tab or a wrong clock cannot
 * stretch the time to first pass past a day, or run it backwards.
 */
export const clampViewedAt = (viewedAt: number, now: number): number =>
  Math.min(now, Math.max(viewedAt, now - DAY_MS));

/**
 * The sandbox's funnel events carry the org id and nothing else: no person, pass, key or address. A step the
 * page reports is a claim; the columns are stamped from what the database holds, so a script cannot invent a pass.
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
  if (beacon.step === 'view' && before?.quickstart_viewed_at == null)
    stamps.quickstart_viewed_at = now;
  if (beacon.step === 'run' || beacon.step === 'fail') {
    const call = before?.first_call_at == null ? await firstCallAt(db, orgId) : null;
    if (call !== null) stamps.first_call_at = call;
  }
  if (beacon.step === 'run' && before?.first_pass_at == null) {
    const pass = await firstPassAt(db, orgId);
    if (pass !== null) stamps.first_pass_at = pass;
  }
  if (beacon.step === 'live' && before?.first_pass_at != null && before.first_preview_at == null)
    stamps.first_preview_at = now;
  await stampFunnel(ctx, orgId, by, stamps);
  const viewed = before?.quickstart_viewed_at ?? stamps.quickstart_viewed_at ?? null;
  if (stamps.first_pass_at !== undefined && viewed !== null)
    writeEvent(
      ctx.env,
      { event: 'dev.ttfp', orgId, mode: 'test', value: Math.max(0, stamps.first_pass_at - viewed) },
      ctx.log,
    );
  writeEvent(
    ctx.env,
    {
      event: `dev.${beacon.step}`,
      orgId,
      mode: 'test',
      ...(beacon.step === 'fail' ? { outcome: beacon.code ?? 'unknown' } : {}),
    },
    ctx.log,
  );
}

/** Sandbox create: the page-view time from the browser's session, stamped once, clamped. */
export async function recordSandboxMade(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  viewedAt: number | undefined,
): Promise<void> {
  const now = ctx.clock.now();
  if (viewedAt !== undefined)
    await stampFunnel(
      ctx,
      orgId,
      { userId: auth.userId, sessionIdHash: auth.sessionId },
      { quickstart_viewed_at: clampViewedAt(viewedAt, now) },
    );
  writeEvent(ctx.env, { event: 'dev.sandbox', orgId, mode: 'test' }, ctx.log);
}
