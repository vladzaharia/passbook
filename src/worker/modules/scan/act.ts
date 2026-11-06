import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitCheckIn } from './act-check-in.ts';
import { type ActRequest, claimOf, requestHashOf } from './act-claim.ts';
import { approvalStop, checkOverride, invalid, pickAction, release } from './act-override.ts';
import { replayOutcome } from './act-replay.ts';
import { answerWithoutRow, finishStop, type StopContext } from './act-stop.ts';
import { verifyApproval } from './approval.ts';
import { readCard, readyOutcome } from './card.ts';
import { planCounts } from './counts.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { countMiss } from './misses.ts';
import { recoverScans } from './recover.ts';
import { claimScan, failScanStmt, reopenScan, scanByKey } from './repo-scans.ts';
import { evaluate } from './resolve.ts';
import { defaultAction } from './resolve-outcome.ts';
import { scanPolicy } from './rules.ts';

const IN_PROGRESS_MS = 15_000;
const WINDOW_REASONS = new Set<ScanReason>(['not_yet_valid', 'ended']);

async function attempt(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
): Promise<ScanOutcome> {
  let counts = planCounts(ctx, actor, req.dayStart);
  const override = await checkOverride(ctx, actor, req, scanId);
  const stopFor = (action: ResolvedScanAction | null): StopContext => ({
    ctx,
    actor,
    scanId,
    method: req.input.method,
    counts,
    action,
    overrideOf: req.overrideOf ?? null,
  });
  const evaluated = await evaluate(ctx, actor, req.input, {
    window: override ? WINDOW_REASONS.has(override.reason) : false,
    confirmed: req.confirmed === true,
    direction: req.direction,
  });
  if (evaluated.stop) {
    if (evaluated.reason === 'not_found') {
      try {
        await countMiss(ctx, actor);
      } catch (error) {
        await release(ctx, scanId);
        throw error;
      }
    }
    const named = evaluated.found?.scan.actions.find((a) => a.id === req.actionId);
    const action = named ?? (evaluated.found ? defaultAction(actor, evaluated.found.scan) : null);
    return finishStop(stopFor(action), evaluated);
  }
  const { found } = evaluated;
  if (found.admission?.event) {
    actor = { ...actor, event: found.admission.event };
    counts = planCounts(ctx, actor, req.dayStart);
  }
  const picked = pickAction(actor, found.scan, req.actionId);
  if (picked === 'choose') {
    const [{ card, read }] = await Promise.all([
      readCard(ctx, actor, found, counts),
      release(ctx, scanId),
    ]);
    return readyOutcome(found, card, read);
  }
  if (picked?.kind !== 'check_in')
    return invalid(ctx, scanId, 'SCAN_ACTION_UNKNOWN', 'Choose an action this pass offers.');
  const action = picked;
  if (override && (override.scan.passId !== found.pass.id || override.scan.actionId !== action.id))
    return invalid(ctx, scanId, 'SCAN_OVERRIDE_INVALID', 'That scan cannot be let through.');

  // Step 14: role, then the right to let someone in again; one Manager PIN covers both.
  const pa = policyActor(actor);
  const checks = [
    scanPolicy(pa, { kind: 'act', minRole: action.minRole }),
    ...(override
      ? [
          scanPolicy(pa, {
            kind: override.reason === 'cooldown' ? 'cooldown_override' : 'let_in_again',
          }),
        ]
      : []),
  ];
  let approvedBy: string | null = null;
  if (checks.some((c) => !c.allow)) {
    const askable = checks.every((c) => c.allow || c.why === 'needs_approval');
    if (!askable || !req.approval) return answerWithoutRow(stopFor(action), approvalStop(found));
    approvedBy = await verifyApproval(ctx, actor, req.approval);
  }
  return commitCheckIn({ ctx, actor, req, scanId, found, action, override, approvedBy, counts });
}

async function execute(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
): Promise<ScanOutcome> {
  try {
    return await attempt(ctx, actor, req, scanId);
  } catch (error) {
    // A thrown error leaves the row `failed`; the same key runs again (SA 7.2).
    await failScanStmt(ctx.env.DB, scanId).run();
    throw error;
  }
}

/** The same key came again. */
async function again(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  hash: string,
): Promise<ScanOutcome> {
  const row = await scanByKey(ctx.env.DB, actor.actorKey, req.idempotencyKey);
  if (!row) return act(ctx, actor, req);
  if (row.requestHash !== hash)
    throw new ValidationError(
      'That key was used for a different scan.',
      [],
      'IDEMPOTENCY_KEY_REUSED',
    );
  if (row.state === 'done') return replayOutcome(ctx, actor, row);
  if (row.state === 'failed') {
    if (await reopenScan(ctx.env.DB, row.id, ctx.clock.now()))
      return execute(ctx, actor, req, row.id);
    return again(ctx, actor, req, hash);
  }
  if (ctx.clock.now() - row.at < IN_PROGRESS_MS)
    throw new AppError('SCAN_IN_PROGRESS', 409, 'This scan is still being recorded. Try again.', {
      headers: { 'retry-after': '1' },
    });
  await recoverScans(ctx, [row]);
  return again(ctx, actor, req, hash);
}

/** `POST /actions` (SA 8.4): claim the key, evaluate, decide, gate, finalize, answer. */
export async function act(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
): Promise<ScanOutcome> {
  const hash = await requestHashOf(req);
  const scanId = ctx.ids.ordered();
  if (!(await claimScan(ctx.env.DB, claimOf(ctx, actor, req, scanId, hash))))
    return again(ctx, actor, req, hash);
  return execute(ctx, actor, req, scanId);
}
