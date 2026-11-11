import { type Grant, grant } from '../../platform/authority.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import type { ScanRow } from './repo-scans.ts';
import type { ScanEventRow } from './repo-scope.ts';

export interface UndoGate {
  scope: string;
  template_id: string;
  kind: string;
  state: string;
  count: number;
  first_at: number;
  last_at: number;
  prev_state: string | null;
  prev_last_at: number | null;
  prev_scan_id: string | null;
}

export interface UndoPresence {
  state: string;
  tracking: number;
  entered_at: number | null;
  first_at: number;
  last_entry_at: number;
  prev_state: string | null;
  prev_tracking: number | null;
  prev_entered_at: number | null;
  prev_first_at: number | null;
  prev_last_entry_at: number | null;
  prev_scan_id: string | null;
}

export interface UndoCommit {
  ctx: ServiceContext;
  actor: ScanActor;
  target: ScanRow & { passId: string; actionId: string };
  gate: UndoGate;
  presence: UndoPresence | null;
  event: ScanEventRow | null;
  /** The manager whose PIN was verified: still enabled, still a manager, same `auth_epoch`. */
  approver: { id: string; authEpoch: number } | null;
  id: string;
  key: string;
}

/** A quarantined pass keeps its scans out of every ledger, undo included. */
function notQuarantined(target: ScanRow): Check[] {
  return [
    rawCheck(
      'retention',
      'NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions WHERE scan_id = ?)',
      [target.id],
    ),
    rawCheck(
      'retention',
      'NOT EXISTS (SELECT 1 FROM passes WHERE id = ? AND test_data_quarantined = 1)',
      [target.passId],
    ),
  ];
}

const UNDO_CODES = { lineage: 'UNDO_SUPERSEDED', retention: 'SCAN_RETAINED' } as const;

/**
 * One batch. The gate, presence and target compare-and-swaps are the grant's lineage checks
 * (`require: 'one'`), so a later scan that took the gate refuses the whole batch with
 * `UNDO_SUPERSEDED` before any write. The actor is the request's own, checked by epochs.
 */
export function undoGrant(c: UndoCommit): Grant {
  const { ctx, actor, target, gate, presence, event, approver, id } = c;
  const now = ctx.clock.now();
  const g = grant(ctx, {
    purpose: 'org_mode.scan.undo',
    principal: scanPrincipal(actor),
    target: target.id,
    codes: UNDO_CODES,
    checks: [
      ...scanActorChecks(actor, { now, event, templateId: target.templateId ?? undefined }),
      ...notQuarantined(target),
      ...(approver
        ? [
            rowIs(
              'scan_staff',
              approver.id,
              { role: 'manager', disabled_at: null, auth_epoch: approver.authEpoch },
              'staff',
            ),
          ]
        : []),
    ],
  });
  const writes = [
    g.update('scan_gates', {
      set: {
        state: target.presenceScope != null ? (gate.prev_state ?? 'undone') : 'undone',
        count: Math.max(0, gate.count - 1),
        last_at: now,
        last_scan_id: id,
        prev_state: null,
        prev_last_at: null,
        prev_scan_id: null,
      },
      where: {
        pass_id: target.passId,
        action_id: target.actionId,
        scope: gate.scope,
        last_scan_id: target.id,
        // The gate's own `last_at`, not `target.at`: gate recovery moves it back to `prev_last_at`.
        last_at: gate.last_at,
        count: gate.count,
        state: gate.state,
        prev_state: gate.prev_state,
      },
      require: 'one',
      returning: ['last_scan_id'],
    }),
    g.update('scans', {
      set: { undone_by: id, undone_at: now },
      where: {
        id: target.id,
        undone_by: null,
        state: 'done',
        outcome: 'ok',
        action_kind: 'check_in',
        at: target.at,
        actor_key: target.actorKey,
      },
      require: 'one',
      returning: ['id'],
    }),
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
        'idempotency_key',
        'request_hash',
        'method',
        'state',
        'outcome',
        'action_id',
        'action_kind',
        'undoes',
        'approved_by',
        'at',
      ],
      [
        id,
        target.passId,
        target.templateId,
        actor.scanner?.id ?? null,
        target.eventId,
        actor.actor.type,
        actor.actor.id,
        actor.actorKey,
        actor.staff?.id ?? null,
        c.key,
        `undo:${target.id}`,
        'manual',
        'done',
        'ok',
        target.actionId,
        'undo',
        target.id,
        approver?.id ?? null,
        now,
      ],
      { returning: ['id'] },
    ),
    g.insertSelect(
      'pass_events',
      ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
      [
        ctx.ids.ordered(now),
        target.passId,
        'scan.undone',
        null,
        actor.actor.type,
        actor.actor.id,
        JSON.stringify({
          scanId: id,
          undoes: target.id,
          actionKind: 'undo',
          outcome: 'ok',
          method: 'manual',
          eventId: target.eventId,
          scannerId: actor.scanner?.id ?? null,
          staffId: actor.staff?.id ?? null,
          approvedBy: approver?.id ?? null,
        }),
        now,
      ],
      { returning: ['id'] },
    ),
    g.audit({
      at: now,
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.undo',
      targetType: 'scan',
      targetId: target.id,
      requestId: ctx.requestId,
      ipPrefix: null,
      detail: JSON.stringify({ kind: 'check_in' }),
    }),
  ];
  if (presence) {
    // The presence row has its own history: its `prev_state`, not the gate's, picks the branch.
    const key = {
      pass_id: target.passId,
      scope: target.presenceScope as string,
      last_scan_id: target.id,
      state: presence.state,
      tracking: presence.tracking,
    };
    writes.push(
      presence.prev_state != null
        ? g.update('scan_presence', {
            set: {
              state: presence.prev_state,
              tracking: presence.prev_tracking,
              entered_at: presence.prev_entered_at,
              first_at: presence.prev_first_at,
              last_entry_at: presence.prev_last_entry_at,
              last_scan_id: presence.prev_scan_id,
              prev_state: null,
              prev_tracking: null,
              prev_entered_at: null,
              prev_first_at: null,
              prev_last_entry_at: null,
              prev_scan_id: null,
            },
            where: {
              ...key,
              prev_state: presence.prev_state,
              prev_tracking: presence.prev_tracking,
              prev_entered_at: presence.prev_entered_at,
              prev_first_at: presence.prev_first_at,
              prev_last_entry_at: presence.prev_last_entry_at,
              prev_scan_id: presence.prev_scan_id,
            },
            require: 'one',
            returning: ['pass_id'],
          })
        : g.delete('scan_presence', {
            where: { ...key, prev_state: null },
            require: 'one',
            returning: ['pass_id'],
          }),
    );
  }
  return g;
}

export async function commitUndo(c: UndoCommit): Promise<void> {
  const { presence } = c;
  const results = await undoGrant(c).commit();
  // A grant that passed wrote every row; a short result means the batch contract broke after commit.
  const rows = (index: number) => results[index]?.results?.length ?? 0;
  if (
    rows(0) !== 1 ||
    rows(1) !== 1 ||
    rows(2) !== 1 ||
    rows(3) !== 1 ||
    (presence && rows(5) !== 1)
  )
    throw new AppError('UNDO_UNCONFIRMED', 500, 'The undo could not be confirmed.');
}
