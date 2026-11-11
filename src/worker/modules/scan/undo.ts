import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, type ScanActor, tenantScanRole } from './actor.ts';
import { verifyApproval } from './approval.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { localDay } from './counts.ts';
import { policyActor } from './dto.ts';
import type { ConsoleUndo } from './feed.ts';
import { undoWindowMinutes } from './outcome.ts';
import { scanByKey } from './repo-scans.ts';
import { commitUndo } from './repo-undo.ts';
import { readUndo } from './repo-undo-read.ts';
import { scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { guardMiss, undoApprovalGuard } from './undo-approval-guard.ts';
import { planUndo, superseded } from './undo-authority.ts';
import { answer, replayUndo, type UndoRequest } from './undo-replay.ts';

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
): Promise<ScanEvaluation> {
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
    return await run(ctx, actor, scanId, read, req, maxAgeMs);
  } catch (error) {
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
): Promise<ScanEvaluation> {
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
    const staff = read.approver;
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
  const id = ctx.ids.ordered();
  await commitUndo({ ctx, actor, ...plan, approver, id, key: req.idempotencyKey });
  return answer(ctx, actor, target.passId, id, false);
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
      timeZone: 'UTC',
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
  );
  return result.outcome;
};
