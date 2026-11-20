import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { VISITOR_COPY } from '../../../shared/copy/visitors.ts';
import { visitorArrivalEmail } from '../../email/visitor.ts';
import { bump } from '../../platform/counters.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf } from '../passes/deps.ts';
import type { ScanActor } from '../scan/guard.ts';
import { scanTarget, type VisitorRow, visitorByPass } from './repo.ts';

/**
 * Mails the host. Best effort: the check-in is committed. A failure is logged by visit id only; the
 * host's address and the visitor's name stay out of logs.
 */
export async function mailHost(
  ctx: ServiceContext,
  v: Pick<VisitorRow, 'id' | 'orgId' | 'name' | 'hostEmail'>,
  at: number,
  place: string,
  timeZone: string,
): Promise<boolean> {
  const mail = visitorArrivalEmail({ name: v.name, place, at, timeZone, base: baseUrl(ctx.env) });
  try {
    await depsOf(ctx.env).mailer.send({ to: v.hostEmail, ...mail });
    return true;
  } catch {
    // Provider errors can carry message content, so none is logged.
    ctx.log.error('visitor.host_notice_failed', {
      orgId: v.orgId,
      visitorId: v.id,
      code: 'VISITOR_HOST_NOTICE_FAILED',
    });
    return false;
  }
}

async function notify(ctx: ServiceContext, actor: ScanActor, scanId: string): Promise<void> {
  const scan = await scanTarget(ctx.env.DB, scanId);
  if (!scan || scan.orgId !== actor.orgId || scan.mode !== actor.mode) return;
  const v = await visitorByPass(ctx.env.DB, scan.orgId, scan.mode, scan.passId);
  if (!v || v.cancelled) return;
  // The first check-in of the visit mails once; a re-entry the same day does not.
  if ((await bump(ctx.env.DB, `visitors:host:${v.id}`, 0)) !== 1) return;
  await mailHost(ctx, v, scan.at, actor.name || VISITOR_COPY.email.place, actor.timeZone);
}

/** After a committed scan: a counted check-in on a visitor's pass tells the host. */
export function notifyHostOfArrival(
  ctx: ServiceContext,
  actor: ScanActor,
  outcome: ScanOutcome,
): void {
  if (outcome.kind !== 'ok' || outcome.replay || outcome.action?.kind !== 'check_in') return;
  if (outcome.occupancy?.direction === 'out' || !outcome.scanId) return;
  ctx.waitUntil(notify(ctx, actor, outcome.scanId));
}

/** The console or an API key sends the host notice again, for a visitor who has arrived. */
export async function resendHostNotice(
  ctx: ServiceContext,
  v: VisitorRow,
  timeZone: string,
): Promise<void> {
  if (v.arrivedAt === null) throw new ConflictError('They have not checked in.', 'VISITOR_NOT_IN');
  if (!(await mailHost(ctx, v, v.arrivedAt, VISITOR_COPY.email.place, timeZone)))
    throw new ConflictError("Couldn't email the host. Try again.", 'VISITOR_HOST_NOTICE_FAILED');
}
