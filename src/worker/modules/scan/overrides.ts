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
import { scanHub } from './live.ts';
import { isOverridable } from './outcome.ts';
import { setOverrideNote } from './override-note.ts';
import { OVERRIDE_WINDOW_MS, resolvedTarget } from './override-scope.ts';
import { overrideEvidenceForTargetStmt } from './repo-act-override.ts';
import { countOverride } from './repo-override-cap.ts';
import { overrideTakenStmt } from './repo-override-note.ts';
import { toScan } from './repo-scan-map.ts';
import { overridePolicyKind, scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

export type OverrideRequest = z.infer<typeof ScanOverrideRequestSchema>;
export type OverrideNoteRequest = z.infer<typeof ScanOverrideNoteRequestSchema>;

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
  ).first<Parameters<typeof toScan>[0] & { taken: number; door_let_in_again: string | null }>();
  if (!row) throw invalid();
  const target = toScan(row);
  if (!isOverridable(target.reason as never) || !target.passId || !target.actionId) throw invalid();
  if (row.taken === 1) throw taken();
  // The door's own letInAgain follows the scan to the desk: `never` closes it for the desk too.
  const door = row.door_let_in_again;
  const pa = policyActor(actor);
  const verdict = scanPolicy(
    door === 'anyone' || door === 'manager' || door === 'never'
      ? { ...pa, settings: { ...pa.settings, letInAgain: door } }
      : pa,
    { kind: overridePolicyKind(target.reason, target.outcome) },
  );
  if (!verdict.allow && verdict.why === 'forbidden')
    throw new ForbiddenError('This door does not let people in again.', 'SCAN_OVERRIDE_FORBIDDEN');
  await countOverride(ctx, actor);
  const request: ActRequest = {
    idempotencyKey: req.idempotencyKey,
    input: { passId: target.passId, method: 'manual' },
    clientTs: now,
    actionId: target.actionId,
    overrideOf: req.overrideOf,
    ...(req.approval ? { approval: req.approval } : {}),
    ...(req.scope ? { scope: req.scope } : {}),
  };
  let result: ScanEvaluation;
  try {
    result = await act(ctx, actor, request);
  } catch (error) {
    // A racing override held the claim: the loser is told who beat it, not that the scan is invalid.
    if (
      error instanceof ValidationError &&
      error.code === 'SCAN_OVERRIDE_INVALID' &&
      (await overrideTakenStmt(db, req.overrideOf).first())
    )
      throw taken();
    throw error;
  }
  const { outcome } = result;
  if (outcome.kind !== 'ok') {
    // A second override that lost the claim or the gate: say who beat it, not that the scan is invalid.
    if (outcome.scanId === null && (await overrideTakenStmt(db, req.overrideOf).first()))
      throw taken();
    return result;
  }
  if (outcome.replay || !outcome.scanId) return result;
  if (req.note)
    await setOverrideNote(ctx, actor, outcome.scanId, req.note).catch(() => {
      ctx.log.error('scan.override.note_failed', {
        orgId: actor.orgId,
        code: 'SCAN_OVERRIDE_NOTE_FAILED',
      });
    });
  const via =
    actor.principal === 'admin'
      ? 'console'
      : actor.scanner?.deviceRole === 'monitor'
        ? 'monitor'
        : 'scanner';
  ctx.waitUntil(
    auditStmt(db, ctx, {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.override',
      targetType: 'scan',
      targetId: outcome.scanId,
      detail: { via, of: req.overrideOf, ...(req.note ? { note: req.note } : {}) },
    })
      .run()
      .catch(() => {
        ctx.log.error('scan.override.audit_failed', {
          orgId: actor.orgId,
          code: 'SCAN_OVERRIDE_AUDIT_FAILED',
        });
      }),
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
