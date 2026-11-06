import type { z } from 'zod';
import type { ScanOutcome, ScanUndoRequestSchema } from '../../../shared/contracts/scan.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { adminActor, type ScanActor } from './actor.ts';
import { verifyApproval } from './approval.ts';
import { localDay, planCounts } from './counts.ts';
import { policyActor } from './dto.ts';
import type { ConsoleUndo } from './feed.ts';
import { blankOutcome, undoWindowMinutes } from './outcome.ts';
import { gateOfScanStmt } from './repo-gates.ts';
import { scanById, scanByKey } from './repo-scans.ts';
import { undoStatements } from './repo-undo.ts';
import { scanPolicy } from './rules.ts';

async function answer(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  replay: boolean,
): Promise<ScanOutcome> {
  const counts = planCounts(ctx, actor);
  return {
    ...blankOutcome('ok', await counts.read(await ctx.env.DB.batch(counts.stmts))),
    scanId,
    replay,
    action: { id: 'undo', label: 'Undone', kind: 'check_in' },
    at: ctx.clock.now(),
  };
}

export async function undo(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  req: z.infer<typeof ScanUndoRequestSchema>,
  maxAgeMs?: number,
): Promise<ScanOutcome> {
  const existing = await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== `undo:${scanId}`)
      throw new ValidationError(
        'That key was used for another scan.',
        [],
        'IDEMPOTENCY_KEY_REUSED',
      );
    return answer(ctx, actor, existing.id, true);
  }
  const target = await scanById(ctx.env.DB, actor.orgId, scanId);
  if (
    !target ||
    target.mode !== actor.mode ||
    target.state !== 'done' ||
    target.outcome !== 'ok' ||
    target.actionKind !== 'check_in' ||
    !target.passId ||
    !target.actionId
  )
    throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
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
  let approvedBy: string | null = null;
  if (!verdict.allow) {
    if ('why' in verdict && verdict.why === 'needs_approval' && req.approval)
      approvedBy = await verifyApproval(ctx, actor, req.approval);
    else
      throw new ForbiddenError(
        'This scan cannot be undone by this operator.',
        'SCAN_UNDO_FORBIDDEN',
      );
  }
  const held = await gateOfScanStmt(ctx.env.DB, target.passId, target.actionId, target.id).first<{
    scope: string;
  }>();
  if (!held) throw new ConflictError('A newer scan has replaced this one.', 'UNDO_SUPERSEDED');
  const id = ctx.ids.ordered();
  try {
    await ctx.env.DB.batch(
      undoStatements(
        ctx,
        actor,
        target,
        { passId: target.passId, actionId: target.actionId, scope: held.scope },
        id,
        req.idempotencyKey,
        approvedBy,
      ),
    );
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const replay = await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey);
    if (replay?.requestHash === `undo:${scanId}`) return answer(ctx, actor, replay.id, true);
    throw error;
  }
  const done = await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey);
  if (!done) throw new ConflictError('A newer scan has replaced this one.', 'UNDO_SUPERSEDED');
  return answer(ctx, actor, done.id, false);
}

export const consoleUndo: ConsoleUndo = (ctx, session, input) =>
  undo(
    ctx,
    adminActor(session, input.mode, {
      orgId: input.orgId,
      templateIds: [],
      event: null,
      timeZone: 'UTC',
    }),
    input.scanId,
    { idempotencyKey: input.idempotencyKey },
    input.maxAgeMs,
  );
