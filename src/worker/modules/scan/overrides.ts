// POST /scan/overrides (SA §20.6): the desk lets a refused or held person in. The request names only the
// scan; its pass, action and place come from that scan, so a monitor cannot redirect anything. The check-in
// itself is `act()` run as an override, so every rule, waiver and fence of a check-in applies.
import type { z } from 'zod';
import type {
  ScanOverrideNoteRequestSchema,
  ScanOverrideRequestSchema,
} from '../../../shared/contracts/scan-occupancy.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { act } from './act.ts';
import type { ActRequest } from './act-claim.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { liveRowId, publishScan, scanHub } from './live.ts';
import { isOverridable } from './outcome.ts';
import { setOverrideNote } from './override-note.ts';
import { OVERRIDE_WINDOW_MS, resolvedTarget } from './override-scope.ts';
import { overrideEvidenceForTargetStmt } from './repo-act-override.ts';
import { eventEpochStmt, sessionEpochStmt } from './repo-authority-capture.ts';
import { assertUnderOverrideCap, countOverride } from './repo-override-cap.ts';
import { overrideTakenStmt } from './repo-override-note.ts';
import { toScan } from './repo-scan-map.ts';
import { readValidEventScope } from './repo-scope.ts';
import { overridePolicyKind, scanPolicy } from './rules.ts';
import { scanEpochsOf, setScanEpochs } from './scan-epochs.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { sessionWindow } from './session-hours.ts';

export type OverrideRequest = z.infer<typeof ScanOverrideRequestSchema>;
export type OverrideNoteRequest = z.infer<typeof ScanOverrideNoteRequestSchema>;

/**
 * A monitor lets in another door's refusal at that door's session, event and zones, never its own
 * (SA 20.9): the actor stays the monitor, for audit and policy.
 */
async function scopedToTarget(
  ctx: ServiceContext,
  actor: ScanActor,
  target: ReturnType<typeof toScan>,
): Promise<ScanActor> {
  if (actor.scanner?.deviceRole !== 'monitor' || target.actorKey === actor.actorKey) return actor;
  const sessionId = target.sessionId ?? null;
  const eventId = target.eventId ?? null;
  const db = ctx.env.DB;
  let targetEpoch: number | null = null;
  // The refusing door's session must still be active and open: a paused, ended or closed one lets nobody in.
  if (sessionId) {
    const session = await sessionEpochStmt(db, sessionId, actor.orgId, actor.mode).first<{
      status: string;
      time_zone: string;
      hours: string | null;
      hold: string | null;
      config_epoch: number;
    }>();
    if (session?.status !== 'active' || !sessionWindow(session, ctx.clock.now()).open)
      throw invalid();
    targetEpoch = session.config_epoch;
  }
  // The pass and action are the target's, so its template is accepted for this one let-in.
  const scoped: ScanActor = {
    ...actor,
    overrideScope: { sessionId, eventId, templateId: target.templateId },
  };
  const base = scanEpochsOf(actor);
  const epochs =
    base && sessionId && targetEpoch !== null
      ? { ...base, targetSession: { id: sessionId, config: targetEpoch } }
      : base;
  if (epochs) setScanEpochs(scoped, epochs);
  if (eventId === (actor.event?.id ?? null)) return scoped;
  if (!eventId) return { ...scoped, event: null };
  // The event, its templates and its epoch are read apart: an edit between the reads is refused.
  const before = await eventEpochStmt(db, eventId, actor.orgId, actor.mode).first<EventEpochRow>();
  const pinned = await readValidEventScope(db, actor.orgId, actor.mode, eventId);
  const after = await eventEpochStmt(db, eventId, actor.orgId, actor.mode).first<EventEpochRow>();
  const e = pinned?.event;
  if (
    !e ||
    !before ||
    !after ||
    before.config_epoch !== after.config_epoch ||
    after.archived_at !== null ||
    after.match_input !== e.matchInput ||
    after.match_values !== e.matchValues ||
    after.opens_at !== e.opensAt ||
    after.closes_at !== e.closesAt ||
    after.time_zone !== e.timeZone ||
    after.capacity !== e.capacity ||
    (after.reentry === 1) !== e.reentry ||
    after.tpl !== JSON.stringify([...pinned.templateIds].sort())
  )
    throw invalid();
  const withEvent: ScanActor = { ...scoped, event: e, templateIds: pinned.templateIds };
  if (epochs)
    setScanEpochs(withEvent, {
      ...epochs,
      events: { ...epochs.events, [e.id]: after.config_epoch },
    });
  return withEvent;
}

interface EventEpochRow {
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  archived_at: number | null;
  config_epoch: number;
  tpl: string;
}

const invalid = () =>
  new ValidationError('That scan cannot be let through.', [], 'SCAN_OVERRIDE_INVALID');
const taken = () => new ConflictError('Someone else already let them in.', 'SCAN_OVERRIDE_TAKEN');

export async function overrideScan(
  ctx: ServiceContext,
  actor: ScanActor,
  req: OverrideRequest,
): Promise<ScanEvaluation> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  // Anything outside the actor's watch, too old or not a refusal reads exactly like an unknown id.
  const row = await overrideEvidenceForTargetStmt(
    db,
    actor,
    req.overrideOf,
    now - OVERRIDE_WINDOW_MS,
    true,
  ).first<
    Parameters<typeof toScan>[0] & {
      taken: number;
      door_let_in_again: string | null;
      door_hard_limit: number | null;
    }
  >();
  if (!row) throw invalid();
  const target = toScan(row);
  if (!isOverridable(target.reason as never) || !target.passId || !target.actionId) throw invalid();
  if (row.taken === 1) throw taken();
  // The door's own letInAgain follows the scan to the desk: `never` closes it for the desk too.
  const door = row.door_let_in_again;
  const pa = policyActor(actor);
  const verdict = scanPolicy(
    {
      ...pa,
      settings: {
        ...pa.settings,
        hardLimit: row.door_hard_limit === 1,
        // Unreadable reads as the strictest.
        letInAgain: door === 'anyone' || door === 'manager' || door === 'never' ? door : 'manager',
      },
    },
    { kind: overridePolicyKind(target.reason, target.outcome) },
  );
  if (!verdict.allow && verdict.why === 'forbidden')
    throw new ForbiddenError(
      row.door_hard_limit === 1
        ? 'Full. No one can let them in.'
        : 'This door does not let people in again.',
      'SCAN_OVERRIDE_FORBIDDEN',
    );
  await assertUnderOverrideCap(ctx, actor);
  const request: ActRequest = {
    idempotencyKey: req.idempotencyKey,
    input: { passId: target.passId, method: 'manual' },
    clientTs: now,
    actionId: target.actionId,
    overrideOf: req.overrideOf,
    ...(req.approval ? { approval: req.approval } : {}),
    ...(req.scope ? { scope: req.scope } : {}),
  };
  const result = await act(ctx, await scopedToTarget(ctx, actor, target), request);
  const { outcome } = result;
  if (outcome.kind !== 'ok') {
    // Lost the gate to another override: say who beat it, not that the scan is invalid.
    if (outcome.scanId === null && (await overrideTakenStmt(db, req.overrideOf).first()))
      throw taken();
    return result;
  }
  if (outcome.replay || !outcome.scanId) return result;
  await countOverride(ctx, actor);
  let note: string | null = null;
  if (req.note)
    try {
      await setOverrideNote(ctx, actor, outcome.scanId, req.note);
      note = req.note;
    } catch {
      ctx.log.error('scan.override.note_failed', {
        orgId: actor.orgId,
        code: 'SCAN_OVERRIDE_NOTE_FAILED',
      });
    }
  const via =
    actor.principal === 'admin'
      ? 'console'
      : actor.scanner?.deviceRole === 'monitor'
        ? 'monitor'
        : 'scanner';
  // The override committed inside `act`; its audit is awaited, and tried twice, so it is not lost with the request.
  const audit = () =>
    auditStmt(db, ctx, {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.override',
      targetType: 'scan',
      targetId: outcome.scanId,
      detail: { via, of: req.overrideOf, ...(note ? { note } : {}) },
    }).run();
  await audit()
    .catch(audit)
    .catch(() => {
      ctx.log.error('scan.override.audit_failed', {
        orgId: actor.orgId,
        code: 'SCAN_OVERRIDE_AUDIT_FAILED',
      });
    });
  // The override's row reaches monitors (the original row reads Resolved) and replaces the customer's slate.
  publishScan(
    ctx,
    actor,
    outcome,
    result.evaluatedSnapshot,
    result.credentialContext,
    'manual',
    false,
    false,
    {
      label: 'Let in',
      overrideOf: req.overrideOf,
      resolvedBy: { staff: actor.staff?.name ?? null, device: actor.name },
      replaces: await liveRowId(req.overrideOf),
    },
  );
  // Only the device that refused hears of it, and not when it did the override itself.
  const refusing = resolvedTarget(actor, target);
  if (refusing) {
    const resolved = {
      of: req.overrideOf,
      outcome: 'ok' as const,
      by: { staff: actor.staff?.name ?? null, device: actor.name },
    };
    ctx.waitUntil(
      scanHub(ctx, actor.orgId, actor.mode)
        .resolved({
          orgId: actor.orgId,
          mode: actor.mode,
          scannerId: refusing,
          resolved,
          now: ctx.clock.now(),
        })
        .then(() => undefined)
        .catch(() => {
          ctx.log.error('scan.override.resolved_failed', {
            orgId: actor.orgId,
            code: 'SCAN_OVERRIDE_RESOLVED_FAILED',
          });
        }),
    );
  }
  return result;
}
