import type { Grant } from '../../platform/authority.ts';
import { not, tenantSql } from '../../platform/authority-cond.ts';
import type { Claim } from './repo-scans.ts';

/** The claim row carries no scan evidence: not a column, a gate or a presence row. */
const PRISTINE = tenantSql(`{row}.pass_id IS NULL AND {row}.template_id IS NULL
  AND {row}.action_id IS NULL AND {row}.action_kind IS NULL AND {row}.pass_version IS NULL
  AND {row}.outcome IS NULL AND {row}.reason IS NULL AND {row}.override_of IS NULL
  AND {row}.approved_by IS NULL AND {row}.direction IS NULL AND {row}.presence_scope IS NULL
  AND {row}.amount IS NULL AND {row}.before_value IS NULL AND {row}.after_value IS NULL
  AND {row}.group_id IS NULL AND {row}.offline = 0 AND {row}.notified = 0
  AND {row}.undoes IS NULL AND {row}.undone_by IS NULL AND {row}.undone_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM scan_gates sg WHERE sg.org_id = {org}
    AND (sg.last_scan_id = {row}.id OR sg.prev_scan_id = {row}.id))
  AND NOT EXISTS (SELECT 1 FROM scan_presence sp WHERE sp.org_id = {org}
    AND (sp.last_scan_id = {row}.id OR sp.prev_scan_id = {row}.id))`);

/** The same key's own claim, as the actor wrote it. */
const ownerOf = (claim: Claim, previousAt: number, previousState: 'failed' | 'pending') => ({
  id: claim.id,
  at: previousAt,
  state: previousState,
  reason: null,
  scanner_id: claim.scannerId,
  event_id: claim.eventId,
  actor_type: claim.actorType,
  actor_id: claim.actorId,
  actor_key: claim.actorKey,
  staff_id: claim.staffId,
  method: claim.method,
  idempotency_key: claim.idempotencyKey,
  request_hash: claim.requestHash,
});

/** Reopen only the observed, pristine failed or expired pending generation. */
export function reopenOnGrant(
  g: Grant,
  claim: Claim,
  previousAt: number,
  nextAt: number,
  previousState: 'failed' | 'pending',
) {
  return g.update('scans', {
    set: { state: 'pending', at: nextAt },
    where: ownerOf(claim, previousAt, previousState),
    returning: ['at'],
    when: [PRISTINE],
  });
}

/** Keep an ambiguous failed generation from being retried: the evidence stays, the row is marked stale. */
export function quarantineOnGrant(g: Grant, claim: Claim, previousAt: number) {
  return g.update('scans', {
    set: { reason: 'stale' },
    where: ownerOf(claim, previousAt, 'failed'),
    returning: ['id'],
    when: [not(PRISTINE)],
  });
}
