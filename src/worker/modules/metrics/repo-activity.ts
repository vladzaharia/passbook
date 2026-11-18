import { all } from '../../platform/db.ts';
import type { Scope, SeriesRow, Window } from './repo.ts';

export interface TemplateRow {
  template_id: string;
  name: string;
  in_wallet: number;
  not_added: number;
  added: number;
  removed: number;
}

const bucket = (col: string) => `(CAST(${col} / ? AS INTEGER) * ?)`;
const REDEEMED = "outcome = 'ok' AND action_kind IN ('use_up', 'take')";

/** Wallet state per template: now for in wallet and not added, in the window for added and removed. */
export function walletRows(
  db: D1Database,
  since: number,
  scope: Required<Pick<Scope, 'orgId'>> & Scope,
) {
  return all<TemplateRow>(
    db,
    `SELECT p.template_id, coalesce(t.name, 'Template') AS name,
       coalesce(sum(p.status = 'active' AND p.removed_at IS NULL AND on_device), 0) AS in_wallet,
       coalesce(sum(p.status = 'active' AND p.removed_at IS NULL AND NOT on_device), 0) AS not_added,
       coalesce(sum(added), 0) AS added,
       coalesce(sum(p.removed_at >= ?), 0) AS removed
     FROM (
       SELECT passes.*,
         EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id) AS on_device,
         EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id AND r.created_at >= ?) AS added
       FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL
     ) p LEFT JOIN templates t ON t.id = p.template_id
     GROUP BY p.template_id`,
    [since, since, scope.orgId, scope.mode],
  );
}

export function issuedByTemplate(db: D1Database, w: Window, scope: Scope) {
  return all<{ template_id: string; n: number }>(
    db,
    `SELECT p.template_id, count(*) AS n FROM pass_versions pv JOIN passes p ON p.id = pv.pass_id
     WHERE pv.cause = 'create' AND pv.created_at >= ? AND p.org_id = ? AND p.mode = ?
     GROUP BY p.template_id`,
    [w.since, scope.orgId ?? '', scope.mode],
  );
}

export function scansByTemplate(db: D1Database, w: Window, scope: Scope) {
  return all<{ template_id: string; scans: number; redemptions: number }>(
    db,
    `SELECT template_id, count(*) AS scans,
       coalesce(sum(${REDEEMED} AND undone_by IS NULL), 0) AS redemptions
     FROM scans WHERE org_id = ? AND mode = ? AND state = 'done' AND at >= ? AND template_id IS NOT NULL
     GROUP BY template_id`,
    [scope.orgId ?? '', scope.mode, w.since],
  );
}

export function scanSeries(db: D1Database, w: Window, scope: Scope) {
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('at')} AS t, count(*) AS n FROM scans
     WHERE org_id = ? AND mode = ? AND state = 'done' AND at >= ? GROUP BY t`,
    [w.bucketMs, w.bucketMs, scope.orgId ?? '', scope.mode, w.since],
  );
}
