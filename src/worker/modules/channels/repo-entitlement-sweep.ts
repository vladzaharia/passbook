import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

export interface SweepCursor {
  updatedAt: number;
  orgId: string;
}

/**
 * Orgs whose entitlements changed in the window, oldest first with the org id as tiebreak, after `cursor`.
 * Changes that need no sweep drop out here: an org an edit has not moved yet, one holding an expired override,
 * and one where every (mode, template) with live passes already has a run, in any state, covering the revision.
 * The scopes (active passes) come from the covering index `passes_scan_population` (index only), and each coverage test is a lookup
 * in `channel_apply_runs_cover`.
 */
export const recentEntitlementOrgs = (
  db: D1Database,
  from: number,
  to: number,
  limit: number,
  now: number = to,
  cursor: SweepCursor | null = null,
) =>
  all<{
    org_id: string;
    revision: number;
    preset: string;
    preset_revision: number;
    updated_at: number;
  }>(
    db,
    `SELECT e.org_id, e.revision, e.preset, e.preset_revision, e.updated_at FROM org_entitlements e
     JOIN orgs o ON o.id = e.org_id
     WHERE e.updated_at >= ? AND e.updated_at < ? AND o.status = 'active'
       AND (e.updated_at, e.org_id) > (?, ?)
       AND NOT EXISTS (SELECT 1 FROM org_entitlement_overrides v WHERE v.org_id = e.org_id
         AND v.expires_at IS NOT NULL AND v.expires_at <= ?)
       AND EXISTS (SELECT 1 FROM (SELECT p.mode, p.template_id FROM passes p
         WHERE p.org_id = e.org_id AND p.deleted_at IS NULL AND p.removed_at IS NULL
           AND p.status = 'active' AND p.test_data_quarantined = 0 GROUP BY p.mode, p.template_id) s
         WHERE NOT EXISTS (SELECT 1 FROM channel_apply_runs r WHERE r.org_id = e.org_id
           AND r.mode = s.mode AND r.template_id = s.template_id
           AND r.from_rev <= e.revision AND r.to_rev >= e.revision))
       AND e.preset_revision >= (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = e.preset)
     ORDER BY e.updated_at, e.org_id LIMIT ?`,
    [from, to, cursor?.updatedAt ?? 0, cursor?.orgId ?? '', now, limit],
  );

/** The audit row of the org's newest entitlement change (the `audit_target` index). */
export const latestEntitlementAudit = (db: D1Database, orgId: string) =>
  all<{ detail: string | null }>(
    db,
    `SELECT detail FROM audit_log
     WHERE target_type = 'org' AND target_id = ? AND action = 'org.entitlements_update'
     ORDER BY at DESC, id DESC LIMIT 1`,
    [orgId],
  );

/** A run of the template in any state covers the revision: its job arrived (a failed run has its own path). */
export const jobArrived = async (
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  revision: number,
): Promise<boolean> =>
  (await first(
    db,
    `SELECT 1 FROM channel_apply_runs WHERE org_id = ? AND mode = ? AND template_id = ?
     AND from_rev <= ? AND to_rev >= ?`,
    [orgId, mode, templateId, revision, revision],
  )) !== null;
