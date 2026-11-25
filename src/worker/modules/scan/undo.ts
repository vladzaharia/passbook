import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { Grant } from '../../platform/authority.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { deferTermClear } from './act-term-stamp.ts';
import { adminActor, captureScanTenantAuthority, type ScanActor, tenantScanRole } from './actor.ts';
import { narrowToRecorded } from './admits.ts';
import { verifyApproval } from './approval.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { localDay } from './counts.ts';
import { policyActor } from './dto.ts';
import type { ConsoleUndo } from './feed.ts';
import { refuseKeyApproval } from './guard-api-key.ts';
import { isDeskMarkOut, undoDeskMarkOut } from './occupancy/undo-mark-out.ts';
import { undoWindowMinutes } from './outcome.ts';
import { scanByKey } from './repo-scans.ts';
import { commitUndo, UNDO_CODES } from './repo-undo.ts';
import { guardMiss, undoApprovalGuard } from './repo-undo-approval-guard.ts';
import { readOccupancyUndo } from './repo-undo-occupancy.ts';
import { readUndo } from './repo-undo-read.ts';
import { prepareUndoRetention } from './repo-undo-retention.ts';
import { scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { planUndoAnswer } from './undo-answer.ts';
import { notFound, planUndo, superseded } from './undo-authority.ts';
import { replayUndo, type UndoRequest } from './undo-replay.ts';
import { commitValueUndo } from './undo-value.ts';

/**
 * Undo a check-in: one read batch, then one grant batch whose gate, presence and target
 * compare-and-swaps decide it, for the actor the request authenticated as. A retry returns the
 * committed result.
 */
export async function undo(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  req: UndoRequest,
  maxAgeMs?: number,
  extra?: (g: Grant) => void,
): Promise<ScanEvaluation> {
  refuseKeyApproval(actor, req);
  if (req.approval && !req.approval.staffId && actor.settings.staffSignIn)
    throw new ValidationError('Choose the manager.', [], 'PIN_MANAGER_REQUIRED');
  const read = await readUndo(
    ctx.env.DB,
    actor.orgId,
    actor.actorKey,
    req.idempotencyKey,
    scanId,
    req.approval?.staffId,
  );
  if (read.existing) return replayUndo(ctx, actor, scanId, read.existing);
  try {
    return await run(ctx, actor, scanId, read, req, maxAgeMs, extra);
  } catch (caught) {
    // A scanner refused as `actor` re-pairs only when its credential is lost.
    const error = await scannerRefusal(ctx, actor, caught);
    // A concurrent request with this key may have committed: that is the retry succeeding.
    const raced =
      (error instanceof AppError && error.code === 'UNDO_SUPERSEDED') ||
      classifyD1Error(error)?.kind === 'unique';
    const won = raced ? await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey) : null;
    if (won) return replayUndo(ctx, actor, scanId, won);
    if (error instanceof AppError)
      ctx.log.warn('scan.undo.refused', { orgId: actor.orgId, code: error.code });
    throw error;
  }
}

async function run(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  read: Awaited<ReturnType<typeof readUndo>>,
  req: UndoRequest,
  maxAgeMs?: number,
  extra?: (g: Grant) => void,
): Promise<ScanEvaluation> {
  // A mixed scope undoes under the entry the scan ran under.
  const scoped = read.target
    ? narrowToRecorded(actor, read.target.eventId, read.target.templateId)
    : actor;
  if (!scoped) throw notFound();
  actor = scoped;
  if (read.target && (await isDeskMarkOut(ctx, read.target)))
    return undoDeskMarkOut(ctx, actor, read.target, read.group, req, maxAgeMs, extra);
  const plan = await planUndo(actor, read);
  const { target } = plan;
  const now = ctx.clock.now();
  if (maxAgeMs !== undefined && now - target.at > maxAgeMs)
    throw new ForbiddenError('This scan is too old to undo.', 'SCAN_UNDO_EXPIRED');
  const verdict =
    maxAgeMs !== undefined && actor.principal === 'admin'
      ? { allow: true }
      : scanPolicy(policyActor(actor), {
          kind: 'undo',
          now,
          undoWindowMinutes: await undoWindowMinutes(ctx),
          scan: {
            actorKey: target.actorKey,
            staffId: target.staffId,
            apiKeyId: target.apiKeyId ?? null,
            at: target.at,
            sameScannerToday:
              target.scannerId === actor.scanner?.id &&
              localDay(target.at, actor.timeZone) === localDay(now, actor.timeZone),
          },
        });
  let approver: { id: string; authEpoch: number } | null = null;
  if (!verdict.allow) {
    if (!('why' in verdict && verdict.why === 'needs_approval' && req.approval))
      throw new ForbiddenError(
        'This scan cannot be undone by this operator.',
        'SCAN_UNDO_FORBIDDEN',
      );
    const verified = await verifyApproval(
      ctx,
      actor,
      req.approval,
      undoApprovalGuard(actor, plan, now),
    );
    if (!verified) {
      // The guard held back the reservation, so no guess was spent: a retry that won, the actor
      // or org lost access, or the target moved.
      const replay = await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey);
      if (replay) return replayUndo(ctx, actor, scanId, replay);
      const denied = await guardMiss(ctx.env.DB, actor, now);
      if (denied) throw denied;
      throw superseded();
    }
    // The PIN snapshot carries no `auth_epoch`. The row read before verification does: use it only
    // if it is the row the PIN verified. Any change since then moves the epoch, and the grant refuses.
    const staff = req.approval.staffId
      ? read.approver
      : { ...verified, pinHash: verified.pinHash, authEpoch: verified.authEpoch, disabledAt: null };
    if (
      !staff ||
      staff.id !== verified.id ||
      staff.role !== 'manager' ||
      staff.disabledAt !== null ||
      staff.pinHash !== verified.pinHash ||
      staff.authEpoch === undefined
    )
      throw new AppError('SCAN_STAFF_CHANGED', 409, 'Staff access changed. Retry the approval.');
    approver = { id: staff.id, authEpoch: staff.authEpoch };
  }
  const occupancy = plan.zone
    ? await readOccupancyUndo(ctx.env.DB, actor.orgId, target.passId, read.group)
    : null;
  const id = ctx.ids.ordered();
  const answer = planUndoAnswer(ctx, actor, target.passId);
  let after: D1Result[];
  try {
    const commit = {
      ctx,
      actor,
      ...plan,
      occupancy,
      approver,
      id,
      key: req.idempotencyKey,
      reads: answer.reads,
    };
    const retention = await prepareUndoRetention(commit);
    const signed = { ...commit, retention };
    after = await (target.actionKind === 'check_in' ? commitUndo(signed) : commitValueUndo(signed));
  } catch (error) {
    if (error instanceof AppError && error.code === UNDO_CODES.stale) throw notFound();
    throw error;
  }
  const finished = answer.finish(after, id);
  deferTermClear({ ctx, actor, target, event: plan.event, approver });
  return finished;
}

export const consoleUndo: ConsoleUndo = async (ctx, session, input) => {
  const authority = await tenantAuthorityOf(
    ctx,
    { ...session, mode: input.mode },
    input.orgId,
    'passes:operate',
  );
  if (authority.kind !== 'session') throw new ForbiddenError();
  const capturedAuthority = await captureScanTenantAuthority(ctx, session, authority);
  const role = tenantScanRole(authority);
  if (!role) throw new ForbiddenError();
  const actor: ScanActor = {
    ...adminActor(session, input.mode, {
      orgId: input.orgId,
      templateIds: [],
      event: null,
      timeZone: DEFAULT_TIME_ZONE,
    }),
    platformSessionId: session.sessionId,
    role,
    tenantAuthority: capturedAuthority,
  };
  // The console actor derives nothing from a device, session or event: its epochs are empty.
  await captureScanEpochs(ctx.env.DB, actor);
  const result = await undo(
    ctx,
    actor,
    input.scanId,
    { idempotencyKey: input.idempotencyKey },
    input.maxAgeMs,
    input.extra,
  );
  return result.outcome;
};
