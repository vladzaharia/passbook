import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

/** Orgs whose entitlements changed in the window, oldest first with the org id as tiebreak. */
export const recentEntitlementOrgs = (db: D1Database, from: number, to: number, limit: number) =>
  all<{ org_id: string; revision: number; preset: string; preset_revision: number }>(
    db,
    `SELECT e.org_id, e.revision, e.preset, e.preset_revision FROM org_entitlements e
     JOIN orgs o ON o.id = e.org_id
     WHERE e.updated_at >= ? AND e.updated_at < ? AND o.status = 'active'
     ORDER BY e.updated_at, e.org_id LIMIT ?`,
    [from, to, limit],
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
