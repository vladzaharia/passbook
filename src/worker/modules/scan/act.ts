import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertEventStmt } from '../events/repo.ts';
import { type ActRequest, claimOf, requestHashOf } from './act-claim.ts';
import { approvalStop, checkOverride, invalid, pickAction, release } from './act-override.ts';
import { replayOutcome } from './act-replay.ts';
import { answerWithoutRow, finishStop, type StopContext } from './act-stop.ts';
import { verifyApproval } from './approval.ts';
import { historyPlan, readCard, readyOutcome } from './card.ts';
import { planCounts } from './counts.ts';
import { policyActor } from './dto.ts';
import { gateRule, gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import { ledgerRow, recordResult } from './ledger.ts';
import { countMiss } from './misses.ts';
import { blankOutcome, canOverride, safeDisplay, undoWindowMinutes } from './outcome.ts';
import { recoverScans } from './recover.ts';
import { eventTotalsStmt } from './repo-counts.ts';
import { type GateClaim, type GateKey, gateHolderStmt, upsertGateStmt } from './repo-gates.ts';
import {
  claimScan,
  failScanStmt,
  finalizeStmt,
  ledgerIfWonStmt,
  reopenScan,
  scanByKey,
} from './repo-scans.ts';
import { activeFlags, evaluate } from './resolve.ts';
import { defaultAction } from './resolve-outcome.ts';
import { scanPolicy } from './rules.ts';

const MINUTE = 60_000;
const IN_PROGRESS_MS = 15_000;
const WINDOW_REASONS = new Set<ScanReason>(['not_yet_valid', 'ended']);

async function attempt(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
): Promise<ScanOutcome> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const counts = planCounts(ctx, actor, req.dayStart);
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
  const event = actor.event;
  if (event?.capacity != null && override?.reason !== 'capacity_full') {
    const row = await eventTotalsStmt(db, actor.orgId, actor.mode, event.id).first<{
      arrived: number;
      inside: number;
    }>();
    if ((event.reentry ? (row?.inside ?? 0) : (row?.arrived ?? 0)) >= event.capacity)
      return finishStop(stopFor(action), { ...approvalStop(found), reason: 'capacity_full' });
  }

  // Step 15 and the effect: gate, finalize and ledger in one batch, counts behind them.
  const gate: GateKey = {
    passId: found.pass.id,
    actionId: action.id,
    scope: gateScope(action, actor, now),
  };
  const claim: GateClaim = {
    ...gate,
    orgId: actor.orgId,
    mode: found.pass.mode,
    templateId: found.pass.templateId,
    kind: action.kind,
    state: 'in',
    scanId,
    now,
    gate:
      override && (override.reason === 'already_done' || override.reason === 'cooldown')
        ? { rule: 'always' }
        : gateRule(action),
  };
  const facts = {
    pass: found.pass,
    scanId,
    action,
    method: req.input.method,
    override: override !== null,
    approvedBy,
  };
  const history = historyPlan(ctx, actor, found);
  const results = await db.batch([
    upsertGateStmt(db, claim),
    finalizeStmt(
      db,
      {
        id: scanId,
        outcome: 'ok',
        reason: null,
        passId: found.pass.id,
        templateId: found.pass.templateId,
        actionId: action.id,
        actionKind: action.kind,
        passVersion: found.pass.version,
        overrideOf: req.overrideOf ?? null,
        approvedBy,
      },
      gate,
    ),
    ledgerIfWonStmt(
      db,
      ledgerRow(ctx, actor, { ...facts, outcome: 'ok', reason: null }),
      gate,
      scanId,
    ),
    gateHolderStmt(db, gate),
    ...counts.stmts,
    ...history.stmts,
  ]);
  const read = await counts.read(results.slice(4, 4 + counts.stmts.length));
  const display = (screen: 'ok' | 'heads_up') =>
    safeDisplay(ctx, actor, found.pass, screen, {
      found,
      history: history.read(results.slice(4 + counts.stmts.length)),
    });
  const asAction = { id: action.id, label: action.label, kind: action.kind };
  if (
    (results[0]?.results?.[0] as { last_scan_id?: string } | undefined)?.last_scan_id === scanId
  ) {
    recordResult(ctx, actor, found.pass.templateId, 'ok');
    const arrived = read.counts.event?.arrived ?? 0;
    const expected = read.counts.event?.expected ?? 0;
    const window = await undoWindowMinutes(ctx);
    return {
      ...blankOutcome('ok', read),
      scanId,
      action: asAction,
      template: found.ref,
      at: now,
      flags: activeFlags(found).map((f) => f.label),
      milestone:
        read.counts.event && expected > 0 && arrived === expected
          ? 'all_in'
          : arrived > 0 && Math.floor(arrived / 100) > Math.floor((arrived - 1) / 100)
            ? 'count'
            : null,
      undoUntil: now + window * MINUTE,
      display: display('ok'),
    };
  }

  // The gate was held. The holder's row says who, where and when.
  const holder = results[3]?.results?.[0] as
    | {
        scan_id: string | null;
        at: number;
        scan_state: string | null;
        last_at: number;
        scanner_name: string | null;
        staff_name: string | null;
        override_of: string | null;
      }
    | undefined;
  const reason: ScanReason =
    holder?.scan_state === 'pending'
      ? 'in_progress'
      : action.repeat === 'cooldown'
        ? 'cooldown'
        : 'already_done';
  await db.batch([
    finalizeStmt(db, {
      id: scanId,
      outcome: 'heads_up',
      reason,
      passId: found.pass.id,
      templateId: found.pass.templateId,
      actionId: action.id,
      actionKind: action.kind,
      passVersion: found.pass.version,
      overrideOf: null,
      approvedBy: null,
    }),
    insertEventStmt(
      db,
      ledgerRow(ctx, actor, { ...facts, outcome: 'heads_up', reason, override: false }),
    ),
  ]);
  recordResult(ctx, actor, found.pass.templateId, reason);
  const remaining =
    reason === 'cooldown' && holder
      ? Math.max(0, holder.last_at + (action.cooldownMinutes ?? 5) * MINUTE - now)
      : null;
  return {
    ...blankOutcome('heads_up', read),
    scanId,
    reason,
    action: asAction,
    template: found.ref,
    at: holder?.at ?? null,
    cooldownRemainingMs: remaining,
    previous: holder?.scan_id
      ? {
          scanId: holder.scan_id,
          at: holder.at,
          scannerName: holder.scanner_name ?? 'Scanner',
          staffName: holder.staff_name,
          actionLabel: action.label,
          override: holder.override_of !== null,
        }
      : null,
    overridable: canOverride(actor, reason, action, read.approvals),
    display: display('heads_up'),
  };
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
