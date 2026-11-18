import { type Grant, grant } from '../../platform/authority.ts';
import type { AfterRead } from '../../platform/authority-after.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
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
  /** Commit order (0074); the restore puts the previous one back. */
  prev_seq?: number | null;
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
  /** The answer's reads: they commit with the grant, so the undo needs no trip of its own for them. */
  reads?: readonly AfterRead[];
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

/**
 * The check-in belongs to the pass's current holder: no transfer is pending (as `scanPassChecks`),
 * and the ledger's recorded credential generation is still the pass's (history redacts it otherwise).
 */
const currentHolder = (target: UndoCommit['target']): Check =>
  rawCheck(
    'stale',
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers x WHERE x.pass_id = ? AND x.state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM pass_events e JOIN passes p ON p.id = e.pass_id
      WHERE e.pass_id = ? AND CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.scanId') = ?
        AND json_type(e.data, '$.authority.credentialGeneration') = 'integer'
        AND json_extract(e.data, '$.authority.credentialGeneration') <> p.credential_generation
        ELSE 0 END)`,
    [target.passId, target.passId, target.id],
  );

/** `UNDO_HOLDER_CHANGED` never leaves the service: it answers as the masked `SCAN_NOT_FOUND`. */
export const UNDO_CODES = {
  lineage: 'UNDO_SUPERSEDED',
  retention: 'SCAN_RETAINED',
  stale: 'UNDO_HOLDER_CHANGED',
} as const;

/** The undo's grant: the actor's epochs, the target's retention and holder, and the approving manager. */
export function openUndoGrant(
  c: UndoCommit,
  extra: { checks?: Check[]; codes?: typeof UNDO_CODES | Record<string, string> } = {},
): Grant {
  const { ctx, actor, target, event, approver } = c;
  const now = ctx.clock.now();
  return grant(ctx, {
    purpose: 'org_mode.scan.undo',
    principal: scanPrincipal(actor),
    target: target.id,
    codes: (extra.codes ?? UNDO_CODES) as typeof UNDO_CODES,
    checks: [
      ...scanActorChecks(actor, { now, event, templateId: target.templateId ?? undefined }),
      ...notQuarantined(target),
      currentHolder(target),
      ...(extra.checks ?? []),
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
}

/** An add, take or set holds a gate only as a clock (`cooldown`): it goes back to the scan before. */
const restoresGate = (kind: string | null) => kind === 'add' || kind === 'take' || kind === 'set';

/** The undo's writes: the gate, the target, the undo scan, its ledger event and the audit row. */
export function addUndoWrites(g: Grant, c: UndoCommit): Grant {
  const { ctx, actor, target, gate, presence, approver, id } = c;
  const now = ctx.clock.now();
  const gateWhere = {
    pass_id: target.passId,
    action_id: target.actionId,
    scope: gate.scope,
    last_scan_id: target.id,
    // The gate's own `last_at`, not `target.at`: gate recovery moves it back to `prev_last_at`.
    last_at: gate.last_at,
    count: gate.count,
    state: gate.state,
    prev_state: gate.prev_state,
  };
  const gateWrite = restoresGate(target.actionKind)
    ? gate.prev_state === null
      ? g.delete('scan_gates', { where: gateWhere, require: 'one', returning: ['last_scan_id'] })
      : g.update('scan_gates', {
          set: {
            state: gate.prev_state,
            count: Math.max(0, gate.count - 1),
            last_at: gate.prev_last_at,
            last_scan_id: gate.prev_scan_id,
            prev_state: null,
            prev_last_at: null,
            prev_scan_id: null,
          },
          where: gateWhere,
          require: 'one',
          returning: ['last_scan_id'],
        })
    : g.update('scan_gates', {
        set: {
          state: target.presenceScope != null ? (gate.prev_state ?? 'undone') : 'undone',
          count: Math.max(0, gate.count - 1),
          last_at: now,
          last_scan_id: id,
          prev_state: null,
          prev_last_at: null,
          prev_scan_id: null,
        },
        where: gateWhere,
        require: 'one',
        returning: ['last_scan_id'],
      });
  const writes = [
    gateWrite,
    g.update('scans', {
      set: { undone_by: id, undone_at: now },
      where: {
        id: target.id,
        undone_by: null,
        state: 'done',
        outcome: 'ok',
        action_kind: target.actionKind ?? 'check_in',
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
        'api_key_id',
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
        actor.apiKeyId ?? null,
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
          ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
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
      detail: JSON.stringify({
        kind: target.actionKind ?? 'check_in',
        ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
      }),
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
              seq: presence.prev_seq ?? 0,
              prev_seq: null,
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
