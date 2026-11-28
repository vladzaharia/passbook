// Undo of a desk Mark as out at a tracked zone: the group's rows go back through the occupancy builder, the
// exit is marked undone, and the undo is a scan of its own with a ledger row and a signed proof. The check-in
// undo needs a gate this exit never wrote, so it has its own path. An event place keeps refusing: its totals
// are retained through the exit's proof.
import type { Grant } from '../../../platform/authority.ts';
import { ForbiddenError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { grantedAudit } from '../../audit/repo-granted.ts';
import { getPass } from '../../passes/repo-read-pass.ts';
import type { ScanActor } from '../actor.ts';
import { localDay, planCounts } from '../counts.ts';
import { policyActor } from '../dto.ts';
import { blankOutcome, undoWindowMinutes } from '../outcome.ts';
import { RACE_SCAN_UNDO } from '../race-tags.ts';
import { includeSystemRetentionProof } from '../repo-scan-retention-part.ts';
import type { ScanRow } from '../repo-scans.ts';
import { addOccupancyUndo, readOccupancyUndo } from '../repo-undo-occupancy.ts';
import { undoEventRow } from '../repo-undo-retention.ts';
import { ROLL_TABLES } from '../roll-call/tables.ts';
import { scanPolicy } from '../rules.ts';
import type { ScanEvaluation } from '../scan-evaluation.ts';
import { prepareSystemScanRetentionProof } from '../scan-retention-proof.ts';
import { SCAN_COMMIT_TABLES, scanIs, scanWriteGrant } from '../scan-write-grant.ts';
import { scannerRefusal } from '../scanner-credential-lost.ts';
import { notFound, superseded } from '../undo-authority.ts';
import type { UndoRequest } from '../undo-replay.ts';
import { outCauseOf } from './repo-mark-out.ts';

/** A desk exit at a zone: the scan Mark as out writes (`out_cause` desk, no action, no gate). */
export async function isDeskMarkOut(ctx: ServiceContext, t: ScanRow | null): Promise<boolean> {
  if (!t || t.actionId !== null || t.direction !== 'out' || !t.presenceScope) return false;
  return (await outCauseOf(ctx.env.DB, t.id)) === 'desk';
}

export async function undoDeskMarkOut(
  ctx: ServiceContext,
  actor: ScanActor,
  t: ScanRow,
  group: readonly { id: string; at: number }[],
  req: UndoRequest,
  maxAgeMs?: number,
  extra?: (g: Grant) => void,
): Promise<ScanEvaluation> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  if (
    t.mode !== actor.mode ||
    t.orgId !== actor.orgId ||
    t.state !== 'done' ||
    t.outcome !== 'ok' ||
    !t.passId ||
    !t.templateId ||
    !t.presenceScope?.startsWith('zone:')
  )
    throw notFound();
  if (t.undoneBy) throw superseded();
  if (maxAgeMs !== undefined && now - t.at > maxAgeMs)
    throw new ForbiddenError('This scan is too old to undo.', 'SCAN_UNDO_EXPIRED');
  // The desk's own exit, within the undo window: the same device and day, or a manager. A session's other
  // devices are the same desk.
  const sameSession = Boolean(t.sessionId) && t.sessionId === actor.scanningSession?.id;
  const verdict =
    maxAgeMs !== undefined && actor.principal === 'admin'
      ? { allow: true }
      : scanPolicy(policyActor(actor), {
          kind: 'undo',
          now,
          undoWindowMinutes: await undoWindowMinutes(ctx),
          scan: {
            actorKey: t.actorKey,
            staffId: t.staffId,
            apiKeyId: t.apiKeyId ?? null,
            at: t.at,
            sameScannerToday:
              (t.scannerId === actor.scanner?.id || sameSession) &&
              localDay(t.at, actor.timeZone) === localDay(now, actor.timeZone),
          },
        });
  if (!verdict.allow)
    throw new ForbiddenError('This scan cannot be undone by this operator.', 'SCAN_UNDO_FORBIDDEN');
  const pass = await getPass(db, t.passId, actor.orgId);
  if (!pass || pass.mode !== actor.mode) throw notFound();
  const occupancy = await readOccupancyUndo(db, actor.orgId, t.passId, group);
  const id = ctx.ids.ordered(now);
  const target = { ...t, passId: t.passId, actionId: '' };
  const c = { ctx, actor, target, approver: null, id, key: req.idempotencyKey } as never;
  const event = undoEventRow(c, now);
  const retention = await prepareSystemScanRetentionProof(ctx.env, event, {
    id,
    orgId: actor.orgId,
    mode: actor.mode,
    templateId: t.templateId,
    scannerId: actor.scanner?.id ?? null,
    eventId: t.eventId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    actorKey: actor.actorKey,
    staffId: actor.staff?.id ?? null,
    approvedBy: null,
    method: 'manual',
    state: 'done',
    outcome: 'ok',
    reason: null,
    actionId: null,
    actionKind: 'undo',
    direction: null,
    passVersion: null,
    presenceScope: null,
    at: now,
    undoes: t.id,
    override: false,
  });
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.undo',
    now,
    pausedSession: true,
    pass: { id: pass.id, facts: { pass, credential: {} } },
    tables: extra ? [...SCAN_COMMIT_TABLES, ...ROLL_TABLES] : SCAN_COMMIT_TABLES,
  });
  addOccupancyUndo(g, c, occupancy);
  g.update('scans', {
    tag: RACE_SCAN_UNDO,
    set: { undone_by: id, undone_at: now },
    where: {
      id: t.id,
      undone_by: null,
      state: 'done',
      outcome: 'ok',
      at: t.at,
      actor_key: t.actorKey,
    },
    require: 'one',
    returning: ['id'],
  });
  g.insertSelect(
    'scans',
    [
      'id',
      'pass_id',
      'template_id',
      'scanner_id',
      'event_id',
      'actor_type',
      'actor_id',
      'actor_key',
      'staff_id',
      'api_key_id',
      'idempotency_key',
      'request_hash',
      'method',
      'state',
      'outcome',
      'action_kind',
      'undoes',
      'at',
    ],
    [
      id,
      t.passId,
      t.templateId,
      actor.scanner?.id ?? null,
      t.eventId,
      actor.actor.type,
      actor.actor.id,
      actor.actorKey,
      actor.staff?.id ?? null,
      actor.apiKeyId ?? null,
      req.idempotencyKey,
      `undo:${t.id}`,
      'manual',
      'done',
      'ok',
      'undo',
      t.id,
      now,
    ],
    { returning: ['id'] },
  );
  g.insertSelect(
    'pass_events',
    ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
    [
      event.id,
      event.pass_id,
      event.kind,
      event.device,
      event.actor_type,
      event.actor_id,
      event.data,
      event.at,
    ],
    { returning: ['id'] },
  );
  grantedAudit(g, ctx, {
    orgId: actor.orgId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    action: 'scan.undo',
    targetType: 'scan',
    targetId: t.id,
    detail: { kind: 'mark_out', ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}) },
  });
  extra?.(g);
  includeSystemRetentionProof(g, retention, [scanIs(id, { state: 'done' })]);
  try {
    await g.commit();
  } catch (error) {
    throw await scannerRefusal(ctx, actor, error);
  }
  const counts = planCounts(ctx, actor);
  const results = await db.batch(counts.stmts);
  return {
    outcome: {
      ...blankOutcome('ok', await counts.read(results)),
      scanId: id,
      replay: false,
      action: { id: 'undo', label: 'Undone', kind: 'check_in' },
      at: now,
    },
    evaluatedSnapshot: null,
    credentialContext: null,
  };
}
