import type { EventRow } from '../events/repo.ts';
import type { UndoCommit } from './repo-undo-types.ts';
import {
  type PreparedScanRetentionProof,
  prepareSystemScanRetentionProof,
} from './scan-retention-proof.ts';

/** The undo's ledger row; it names the undo grant as its authority. */
export function undoEventRow(c: Omit<UndoCommit, 'retention'>, now: number): EventRow {
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
    }),
    at: now,
  };
}

/** Signed before the grant opens, at the one clock the undo's rows share. A target with no template cannot be attested. */
export async function prepareUndoRetention(
  c: Omit<UndoCommit, 'retention'>,
): Promise<PreparedScanRetentionProof | null> {
  const { ctx, actor, target, approver } = c;
  if (target.templateId === null) return null;
  const now = ctx.clock.now();
  return prepareSystemScanRetentionProof(ctx.env, undoEventRow(c, now), {
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
