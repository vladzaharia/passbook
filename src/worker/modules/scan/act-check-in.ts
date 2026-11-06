import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertEventStmt } from '../events/repo.ts';
import type { ActRequest } from './act-claim.ts';
import type { checkOverride } from './act-override.ts';
import { completedAdmission, planAdmission } from './admission.ts';
import { historyPlan } from './card.ts';
import type { CountsPlan } from './counts.ts';
import { gateRule, gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import { ledgerRow, recordResult } from './ledger.ts';
import { blankOutcome, canOverride, safeDisplay, undoWindowMinutes } from './outcome.ts';
import { recordPresenceStmt } from './repo-admission.ts';
import { type GateClaim, type GateKey, gateHolderStmt, upsertGateStmt } from './repo-gates.ts';
import { finalizeStmt, ledgerIfWonStmt } from './repo-scans.ts';
import { activeFlags, type Found } from './resolve.ts';

interface CommitInput {
  ctx: ServiceContext;
  actor: ScanActor;
  req: ActRequest;
  scanId: string;
  found: Found;
  action: ResolvedScanAction;
  override: Awaited<ReturnType<typeof checkOverride>>;
  approvedBy: string | null;
  counts: CountsPlan;
}
const MINUTE = 60_000;

export async function commitCheckIn(input: CommitInput): Promise<ScanOutcome> {
  const { ctx, actor, req, scanId, found, action, override, approvedBy, counts } = input;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const event = actor.event;
  // Step 15 and the effect: gate, finalize and ledger in one batch, counts behind them.
  const gate: GateKey = {
    passId: found.pass.id,
    actionId: action.id,
    scope:
      found.admission && (found.checkInRules?.mode || actor.settings.checkIn?.mode)
        ? found.admission.scope
        : gateScope(action, actor, now),
  };
  const claim: GateClaim = {
    ...gate,
    ...(event?.capacity != null &&
    found.admission?.state.direction !== 'out' &&
    override?.reason !== 'capacity_full'
      ? { capacity: { eventId: event.id, max: event.capacity, reentry: event.reentry } }
      : {}),
    orgId: actor.orgId,
    mode: found.pass.mode,
    templateId: found.pass.templateId,
    kind: action.kind,
    state: found.admission?.state.direction ?? 'in',
    admission: found.admission,
    scanId,
    now,
    gate:
      override && (override.reason === 'already_done' || override.reason === 'cooldown')
        ? { rule: 'always' }
        : found.checkInRules?.mode || actor.settings.checkIn?.mode
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
    direction: found.admission?.state.direction,
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
        direction: found.admission?.state.direction,
        presenceScope: found.admission?.scope,
        eventId: event?.id,
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
    ...(found.admission
      ? [recordPresenceStmt(db, actor.orgId, gate, scanId, now, found.admission)]
      : []),
    ...counts.stmts,
    ...history.stmts,
  ]);
  const offset = found.admission ? 5 : 4;
  const read = await counts.read(results.slice(offset, offset + counts.stmts.length));
  const display = (screen: 'ok' | 'heads_up') =>
    safeDisplay(ctx, actor, found.pass, screen, {
      found,
      history: history.read(results.slice(offset + counts.stmts.length)),
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
      checkIn: found.admission ? completedAdmission(found.admission, now) : undefined,
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
  const fresh = found.admission
    ? await planAdmission(ctx, actor, found, found.admission.state.direction)
    : null;
  const reason: ScanReason =
    fresh?.reason ??
    (event?.capacity != null &&
    ((event.reentry ? read.counts.event?.inside : read.counts.event?.arrived) ?? 0) >=
      event.capacity
      ? 'capacity_full'
      : holder?.scan_state === 'pending'
        ? 'in_progress'
        : action.repeat === 'cooldown'
          ? 'cooldown'
          : 'already_done');
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
    overridable: !fresh?.reason && canOverride(actor, reason, action, read.approvals),
    display: display('heads_up'),
  };
}
