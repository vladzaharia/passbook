import type { SessionAuth } from '../../platform/auth.ts';
import { grant, jobGrant } from '../../platform/authority.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requirePersonalRelease } from '../orgs/personal-guard.ts';
import {
  commitEnrolmentStep,
  ENROLMENT_TABLES,
  type EnrolmentRow,
  type EnrolmentStep,
  findEnrolment,
  lastHoldActor,
  maxEventRevision,
  orgStatus,
} from './repo-enrolments.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';
const changed = () =>
  new ConflictError('The wallet account changed. Reload and retry.', 'WALLET_ACCOUNT_CONFLICT');

export interface HoldScope {
  orgId: string;
  mode: Mode;
  provider: Provider;
}

export function adminOf(
  auth: SessionAuth,
  scope: HoldScope,
): Extract<Principal, { kind: 'platform' }> {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  const session = auth;
  if (!session.roles.includes('admin')) throw new ForbiddenError('Admin access is required.');
  return {
    kind: 'platform',
    userId: session.userId,
    sessionIdHash: session.sessionId,
    orgId: scope.orgId,
    mode: scope.mode,
  };
}

/** A hold or release steps past the highest event, so a stray event at the next revision cannot block it. */
async function platformStep(
  ctx: ServiceContext,
  row: EnrolmentRow,
  scope: HoldScope,
  kind: 'hold' | 'release',
  userId: string,
  reason: string | undefined,
): Promise<EnrolmentStep> {
  const at = ctx.clock.now();
  return {
    accountId: row.id,
    isNew: false,
    provider: scope.provider,
    expectedRevision: row.enrolment_revision,
    revision: Math.max(row.enrolment_revision, await maxEventRevision(ctx.env.DB, row.id)) + 1,
    event: {
      id: ctx.ids.id(),
      kind,
      ...(reason ? { reason } : {}),
      actor: { type: 'platform', id: userId },
      createdAt: at,
    },
    set:
      kind === 'hold'
        ? { enabled_at: null, platform_hold_at: at, platform_hold_reason: reason ?? null }
        : { platform_hold_at: null, platform_hold_reason: null },
  };
}

async function heldRow(
  ctx: ServiceContext,
  scope: HoldScope,
  wantHeld: boolean,
): Promise<EnrolmentRow> {
  const row = await findEnrolment(ctx.env.DB, scope.orgId, scope.mode, scope.provider);
  if (!row) throw new NotFoundError();
  if (row.revoked_at !== null || (row.platform_hold_at !== null) !== wantHeld) throw changed();
  return row;
}

/** Holds an enrolment. A suspended org takes the hold through its job; `queued` says so. */
export async function holdEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: HoldScope,
  reason: string,
): Promise<'held' | 'queued'> {
  const principal = adminOf(auth, scope);
  const row = await heldRow(ctx, scope, false);
  const status = await orgStatus(ctx.env.DB, scope.orgId);
  if (status === null || status === 'deleted') throw new NotFoundError();
  if (status === 'suspended') {
    await ctx.env.JOBS.send({
      kind: 'wallet.enrolment_hold',
      ...scope,
      reason,
      userId: principal.userId,
    });
    return 'queued';
  }
  const g = grant(ctx, {
    purpose: 'org_mode.wallet.enrolment_hold',
    principal,
    tables: ENROLMENT_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, scope, 'hold', principal.userId, reason),
  );
  return 'held';
}

export async function releaseEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: HoldScope,
): Promise<'released'> {
  const principal = adminOf(auth, scope);
  const row = await heldRow(ctx, scope, true);
  await requirePersonalRelease(
    ctx.env.DB,
    scope.orgId,
    principal.userId,
    await lastHoldActor(ctx.env.DB, row.id),
  );
  const status = await orgStatus(ctx.env.DB, scope.orgId);
  if (status === null || status === 'deleted') throw new NotFoundError();
  const g = grant(ctx, {
    purpose: 'org_mode.wallet.enrolment_release',
    principal,
    tables: ENROLMENT_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, scope, 'release', principal.userId, undefined),
  );
  return 'released';
}

/** The hold of a suspended org, as a job: the event and the audit row name the platform user who asked. */
export async function runEnrolmentHold(
  ctx: ServiceContext,
  job: HoldScope & { reason: string; userId: string },
): Promise<void> {
  const row = await findEnrolment(ctx.env.DB, job.orgId, job.mode, job.provider);
  if (!row || row.revoked_at !== null || row.platform_hold_at !== null) return;
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.wallet.enrolment_hold',
    job: 'wallet',
    orgId: job.orgId,
    mode: job.mode,
    inactiveOk: true,
    tables: ENROLMENT_TABLES,
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, job, 'hold', job.userId, job.reason),
  );
}
