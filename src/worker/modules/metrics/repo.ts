import { all, first, type SqlValue } from '../../platform/db.ts';

export interface Scope {
  orgId?: string;
  templateId?: string;
}

export interface SeriesRow {
  t: number;
  n: number;
}

export interface Window {
  since: number;
  bucketMs: number;
}

export interface PassTotals {
  passes: number;
  active: number;
  voided: number;
  holders: number;
  devices: number;
}

function passWhere(scope: Scope, alias = 'p'): { sql: string; params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (scope.orgId) {
    parts.push(`${alias}.org_id = ?`);
    params.push(scope.orgId);
  }
  if (scope.templateId) {
    parts.push(`${alias}.template_id = ?`);
    params.push(scope.templateId);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

/** Org-scoped totals use the org index; platform-wide totals scan, so callers cache them. */
export async function passTotals(db: D1Database, scope: Scope): Promise<PassTotals> {
  const w = passWhere(scope);
  const row = await first<Omit<PassTotals, 'devices'>>(
    db,
    `SELECT count(*) AS passes, coalesce(sum(p.status = 'active'), 0) AS active,
            coalesce(sum(p.status = 'voided'), 0) AS voided, count(p.holder_email) AS holders
     FROM passes p WHERE p.deleted_at IS NULL${w.sql}`,
    w.params,
  );
  const devices = await first<{ n: number }>(
    db,
    scope.orgId || scope.templateId
      ? `SELECT count(DISTINCT r.device_id) AS n FROM registrations r JOIN passes p ON p.id = r.pass_id WHERE p.deleted_at IS NULL${w.sql}`
      : 'SELECT count(*) AS n FROM devices',
    scope.orgId || scope.templateId ? w.params : [],
  );
  return {
    passes: row?.passes ?? 0,
    active: row?.active ?? 0,
    voided: row?.voided ?? 0,
    holders: row?.holders ?? 0,
    devices: devices?.n ?? 0,
  };
}

// Bound numbers arrive as REAL, so the quotient is cast back to an integer before scaling.
const bucket = (col: string) => `(CAST(${col} / ? AS INTEGER) * ?)`;

/** Bind order for the shared shape: bucket twice (select), since, then scope params. */
function ordered(w: Window, extra: SqlValue[], since = true): SqlValue[] {
  return since ? [w.bucketMs, w.bucketMs, w.since, ...extra] : [w.bucketMs, w.bucketMs, ...extra];
}

export function issuedRows(db: D1Database, w: Window, scope: Scope) {
  const pw = passWhere(scope);
  const join = scope.orgId || scope.templateId ? 'JOIN passes p ON p.id = pv.pass_id' : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('pv.created_at')} AS t, count(*) AS n FROM pass_versions pv ${join}
     WHERE pv.cause = 'create' AND pv.created_at >= ?${pw.sql} GROUP BY t`,
    ordered(w, pw.params),
  );
}

export function updatedRows(db: D1Database, w: Window, scope: Scope, causes: string[]) {
  const pw = passWhere(scope);
  const join = scope.orgId || scope.templateId ? 'JOIN passes p ON p.id = pv.pass_id' : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('pv.created_at')} AS t, count(*) AS n FROM pass_versions pv ${join}
     WHERE pv.cause IN (${causes.map(() => '?').join(', ')}) AND pv.created_at >= ?${pw.sql} GROUP BY t`,
    [w.bucketMs, w.bucketMs, ...causes, w.since, ...pw.params],
  );
}

export function registrationRows(db: D1Database, w: Window, scope: Scope) {
  const pw = passWhere(scope);
  const join = scope.orgId || scope.templateId ? 'JOIN passes p ON p.id = r.pass_id' : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('r.created_at')} AS t, count(*) AS n FROM registrations r ${join}
     WHERE r.created_at >= ?${pw.sql} GROUP BY t`,
    ordered(w, pw.params),
  );
}

/** Outbox rows by kind; `failed` counts failed and partial deliveries. */
export function outboxRows(
  db: D1Database,
  w: Window,
  scope: Scope,
  kind: 'push' | 'email',
  failedOnly: boolean,
) {
  const orgClause = scope.orgId ? ' AND org_id = ?' : '';
  const failed = failedOnly ? " AND state IN ('failed', 'partial')" : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('created_at')} AS t, count(*) AS n FROM outbox
     WHERE kind = ? AND created_at >= ?${orgClause}${failed} GROUP BY t`,
    [w.bucketMs, w.bucketMs, kind, w.since, ...(scope.orgId ? [scope.orgId] : [])],
  );
}

export function syncRunRows(db: D1Database, w: Window, scope: Scope) {
  const join = scope.orgId ? 'JOIN connections c ON c.id = cr.connection_id' : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('cr.started_at')} AS t, count(*) AS n FROM connection_runs cr ${join}
     WHERE cr.started_at >= ?${scope.orgId ? ' AND c.org_id = ?' : ''} GROUP BY t`,
    ordered(w, scope.orgId ? [scope.orgId] : []),
  );
}

export function signInRows(db: D1Database, w: Window, scope: Scope) {
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('at')} AS t, count(*) AS n FROM audit_log
     WHERE action LIKE 'auth.sign_in%' AND at >= ?${scope.orgId ? ' AND org_id = ?' : ''} GROUP BY t`,
    ordered(w, scope.orgId ? [scope.orgId] : []),
  );
}

export async function orgExists(db: D1Database, orgId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS x FROM orgs WHERE id = ?', [orgId])) !== null;
}

export interface RecentRow {
  at: number;
  action: string;
  org_id: string | null;
  target_id: string | null;
}

export function recentAudit(db: D1Database, scope: Scope, limit: number) {
  return all<RecentRow>(
    db,
    `SELECT at, action, org_id, target_id FROM audit_log
     ${scope.orgId ? 'WHERE org_id = ?' : ''} ORDER BY at DESC LIMIT ?`,
    [...(scope.orgId ? [scope.orgId] : []), limit],
  );
}
