import { first } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import type { UndoCommit } from './repo-undo-types.ts';
import {
  type PreparedScanRetentionProof,
  prepareSystemScanRetentionProof,
} from './scan-retention-proof.ts';

/** The undo's ledger row; it names the undo grant as its authority. */
export function undoEventRow(
  c: Omit<UndoCommit, 'retention'>,
  now: number,
  after: PostUndo | null = null,
): EventRow {
  const { ctx, actor, target, approver } = c;
  return {
    id: ctx.ids.ordered(now),
    org_id: actor.orgId,
    pass_id: target.passId,
    mode: actor.mode,
    kind: 'scan.undone',
    device: null,
    actor_type: actor.actor.type,
    actor_id: actor.actor.id,
    data: JSON.stringify({
      scanId: c.id,
      undoes: target.id,
      actionKind: 'undo',
      outcome: 'ok',
      method: 'manual',
      eventId: target.eventId,
      scannerId: actor.scanner?.id ?? null,
      staffId: actor.staff?.id ?? null,
      approvedBy: approver?.id ?? null,
      ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
      authority: { kind: 'undo', purpose: 'org_mode.scan.undo', undoes: target.id },
      ...(after ?? {}),
    }),
    at: now,
  };
}

type PostUndo = {
  postUndoGate: Record<string, unknown>;
  postUndoPresence: Record<string, unknown> | null;
};

/**
 * The gate and presence an undo of an event check-in leaves, as the undo's own grant writes them
 * (addUndoWrites): the gate stays a clock the undo owns; the presence goes back to its previous row or is
 * deleted. Null for any other target, which retains nothing.
 */
async function postUndo(c: Omit<UndoCommit, 'retention'>, now: number): Promise<PostUndo | null> {
  const { ctx, actor, target, gate, presence } = c;
  const scope = target.presenceScope;
  if (target.actionKind !== 'check_in' || gate.kind !== 'check_in' || !scope?.startsWith('event:'))
    return null;
  const ref = await first<{ ref: string | null }>(
    ctx.env.DB,
    `SELECT json_extract(data, '$.actionIdRef') AS ref FROM pass_events WHERE pass_id = ? AND org_id = ?
       AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.scanId') END) = ? LIMIT 1`,
    [target.passId, actor.orgId, target.id],
  );
  if (!ref?.ref) return null;
  const restored = presence?.prev_state != null;
  return {
    postUndoGate: {
      passId: target.passId,
      orgId: actor.orgId,
      mode: actor.mode,
      templateId: target.templateId,
      actionIdRef: ref.ref,
      scope: gate.scope,
      kind: 'check_in',
      state: gate.prev_state ?? 'undone',
      count: Math.max(0, gate.count - 1),
      firstAt: gate.first_at,
      lastAt: now,
      lastScanId: c.id,
      prevState: null,
      prevLastAt: null,
      prevScanId: null,
    },
    postUndoPresence:
      presence && restored
        ? {
            passId: target.passId,
            orgId: actor.orgId,
            scope,
            state: presence.prev_state,
            tracking: presence.prev_tracking,
            enteredAt: presence.prev_entered_at,
            firstAt: presence.prev_first_at,
            lastEntryAt: presence.prev_last_entry_at,
            lastScanId: presence.prev_scan_id,
            prevState: null,
            prevTracking: null,
            prevEnteredAt: null,
            prevFirstAt: null,
            prevLastEntryAt: null,
            prevScanId: null,
          }
        : null,
  };
}

/** Signed before the grant opens, at the one clock the undo's rows share. A target with no template cannot be attested. */
export async function prepareUndoRetention(
  c: Omit<UndoCommit, 'retention'>,
): Promise<PreparedScanRetentionProof | null> {
  const { ctx, actor, target, approver } = c;
  if (target.templateId === null) return null;
  const now = ctx.clock.now();
  return prepareSystemScanRetentionProof(ctx.env, undoEventRow(c, now, await postUndo(c, now)), {
    id: c.id,
    orgId: actor.orgId,
    mode: actor.mode,
    templateId: target.templateId,
    scannerId: actor.scanner?.id ?? null,
    eventId: target.eventId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    actorKey: actor.actorKey,
    staffId: actor.staff?.id ?? null,
    approvedBy: approver?.id ?? null,
    method: 'manual',
    state: 'done',
    outcome: 'ok',
    reason: null,
    actionId: target.actionId,
    actionKind: 'undo',
    direction: null,
    passVersion: null,
    presenceScope: null,
    at: now,
    undoes: target.id,
    override: false,
  });
}
