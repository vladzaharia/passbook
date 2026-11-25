import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { revokeSessionsWithRole } from '../auth/repo-sessions.ts';
import { type DriftKind, type DriftRow, recordDrift, resolveDrift } from './repo-drift.ts';
import { holdTarget, recordApplied, recordError, recordObserved } from './repo-state.ts';
import { settleEndedSponsors } from './repo-sync.ts';
import type { Target } from './types.ts';

/** A Polaris ID subject and the PassBook user behind it, when there is one. */
export interface Who {
  subject: string;
  userId: string | null;
}

type SessionRole = 'admin' | 'user' | 'console' | 'developer';

/** The session role that a target gives, if any. Custom groups and support give none. */
export const sessionRoleOf = (target: Target): SessionRole | null =>
  target === 'console' || target === 'developer' ? target : null;

/** Every effect leaves an audit row (platform scope, system actor). Only ids and target names go in. */
export function auditEffect(
  ctx: ServiceContext,
  action: string,
  who: Who,
  detail: Record<string, unknown>,
): Promise<void> {
  return recordAudit(ctx, {
    actorType: 'system',
    action,
    targetType: who.userId ? 'user' : 'idp_subject',
    targetId: who.userId ?? who.subject,
    detail,
  });
}

/** Records a difference once. `open` is the subject's open list when the caller has it: a repeat then costs no query. */
export async function noteDrift(
  ctx: ServiceContext,
  runId: string,
  who: Who,
  target: Target,
  kind: DriftKind,
  open: readonly DriftRow[] = [],
): Promise<void> {
  if (open.some((d) => d.target === target && d.kind === kind)) return;
  await recordDrift(ctx.env.DB, {
    id: ctx.ids.id(),
    runId,
    userId: who.userId,
    subject: who.subject,
    target,
    kind,
    now: ctx.clock.now(),
  });
}

/** Closes the open differences of these kinds for a target. `open` is the subject's list, read once. */
export async function closeDrift(
  ctx: ServiceContext,
  who: Who,
  target: Target,
  open: readonly DriftRow[],
  kinds: readonly DriftKind[],
  resolution: string,
): Promise<void> {
  for (const row of open)
    if (row.target === target && kinds.includes(row.kind))
      await resolveDrift(ctx.env.DB, who.subject, target, row.kind, resolution, ctx.clock.now());
}

/** Ends the user's Polaris ID sessions that hold `role`. Audited when any ended. */
export async function endSessions(
  ctx: ServiceContext,
  who: Who,
  role: SessionRole,
  why: string,
): Promise<number> {
  if (!who.userId) return 0;
  const count = await revokeSessionsWithRole(ctx.env.DB, who.userId, role, ctx.clock.now());
  if (count > 0) {
    await auditEffect(ctx, 'idp.sessions_revoked', who, { role, reason: why, count });
    ctx.log.info('idp.sessions_revoked', { userId: who.userId, role, reason: why, count });
  }
  return count;
}

/** PassBook added a target and the write was read back. */
export async function addedTarget(ctx: ServiceContext, who: Who, target: Target): Promise<void> {
  await recordApplied(ctx.env.DB, {
    ...who,
    target,
    observed: true,
    presence: 'passbook',
    now: ctx.clock.now(),
  });
  await auditEffect(ctx, 'idp.access_added', who, { target });
}

/**
 * PassBook removed a target (or the binding ended the grant of a role already gone). A developer removal ends
 * developer sessions; a removal never touches email-link sessions.
 */
export async function removedTarget(
  ctx: ServiceContext,
  who: Who,
  target: Target,
  why: string,
): Promise<void> {
  await recordApplied(ctx.env.DB, {
    ...who,
    target,
    observed: false,
    presence: 'none',
    now: ctx.clock.now(),
  });
  await auditEffect(ctx, 'idp.access_removed', who, { target, reason: why });
  if (target === 'developer') await endSessions(ctx, who, 'developer', why);
}

/** What the last read showed; only written when it differs from the record, so a repeat run writes nothing. */
export async function observeTarget(
  ctx: ServiceContext,
  who: Who,
  target: Target,
  seen: { present: boolean; presence: 'none' | 'passbook' | 'external' },
  before: { observed: 0 | 1 | null; presence: string; error_code: string | null } | undefined,
): Promise<void> {
  if (
    before &&
    before.observed === (seen.present ? 1 : 0) &&
    before.presence === seen.presence &&
    before.error_code === null
  )
    return;
  await recordObserved(ctx.env.DB, {
    ...who,
    target,
    observed: seen.present,
    presence: seen.presence,
    now: ctx.clock.now(),
  });
}

/** The owner took a role PassBook added: hold it, end the sessions that carry it, report it. Never re-added. */
export async function holdTargetForOwner(
  ctx: ServiceContext,
  runId: string,
  who: Who,
  target: Target,
): Promise<void> {
  await holdTarget(ctx.env.DB, who.subject, target, who.userId, ctx.clock.now());
  await noteDrift(ctx, runId, who, target, 'owner_removed');
  await auditEffect(ctx, 'idp.access_held', who, { target });
  ctx.log.info('idp.access_held', { userId: who.userId, target });
  const role = sessionRoleOf(target);
  if (role) await endSessions(ctx, who, role, 'owner_removed');
}

/** A write that failed for good, or a target the binding will not touch: the code stays on the record. */
export const failTarget = (ctx: ServiceContext, who: Who, target: Target, code: string) =>
  recordError(ctx.env.DB, who.subject, target, who.userId, code);

/** The ended sponsorships of the user are settled once their developer group effect is done. */
export async function settleSponsorships(ctx: ServiceContext, who: Who): Promise<void> {
  if (!who.userId) return;
  const settled = await settleEndedSponsors(ctx, who.userId);
  if (settled > 0) ctx.log.info('idp.sponsorships_settled', { userId: who.userId, count: settled });
}
