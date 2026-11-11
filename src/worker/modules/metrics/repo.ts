import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';

export interface Scope {
  orgId?: string;
  templateId?: string;
  /** Test passes never count in live figures, and the reverse. */
  mode: Mode;
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
  const parts: string[] = [`${alias}.mode = ?`];
  const params: SqlValue[] = [scope.mode];
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

/** A template filter may name an org-owned or shared platform template. */
export async function templateUsableByOrg(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      "SELECT 1 FROM templates WHERE id = ? AND (org_id = ? OR org_id IS NULL) AND status != 'deleted'",
      [templateId, orgId],
    )) !== null
  );
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
    `SELECT count(DISTINCT r.device_id) AS n FROM registrations r JOIN passes p ON p.id = r.pass_id WHERE p.deleted_at IS NULL${w.sql}`,
    w.params,
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
  const join = 'JOIN passes p ON p.id = pv.pass_id';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('pv.created_at')} AS t, count(*) AS n FROM pass_versions pv ${join}
     WHERE pv.cause = 'create' AND pv.created_at >= ?${pw.sql} GROUP BY t`,
    ordered(w, pw.params),
  );
}

export function updatedRows(db: D1Database, w: Window, scope: Scope, causes: string[]) {
  const pw = passWhere(scope);
  const join = 'JOIN passes p ON p.id = pv.pass_id';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('pv.created_at')} AS t, count(*) AS n FROM pass_versions pv ${join}
     WHERE pv.cause IN (${causes.map(() => '?').join(', ')}) AND pv.created_at >= ?${pw.sql} GROUP BY t`,
    [w.bucketMs, w.bucketMs, ...causes, w.since, ...pw.params],
  );
}

export function registrationRows(db: D1Database, w: Window, scope: Scope) {
  const pw = passWhere(scope);
  const join = 'JOIN passes p ON p.id = r.pass_id';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('r.created_at')} AS t, count(*) AS n FROM registrations r ${join}
     WHERE r.created_at >= ?${pw.sql} GROUP BY t`,
    ordered(w, pw.params),
  );
}

/** Outbox rows by kind, with ambiguous email outcomes separate from known failures. */
export function outboxRows(
  db: D1Database,
  w: Window,
  scope: Scope,
  kind: 'push' | 'email',
  outcome: 'all' | 'failed' | 'unknown',
) {
  const orgClause = scope.orgId ? ' AND o.org_id = ?' : '';
  const templateClause = scope.templateId ? ' AND p.template_id = ?' : '';
  const unknown = "o.state = 'partial' AND o.error_code = 'EMAIL_OUTCOME_UNKNOWN'";
  const filter =
    outcome === 'unknown'
      ? ` AND ${unknown}`
      : outcome === 'failed'
        ? ` AND o.state IN ('failed', 'partial')${kind === 'email' ? ` AND NOT (o.state = 'partial' AND coalesce(o.error_code, '') = 'EMAIL_OUTCOME_UNKNOWN')` : ''}`
        : '';
  // Rows without a pass (sign-in mail) belong to live.
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('o.created_at')} AS t, count(*) AS n FROM outbox o
     LEFT JOIN passes p ON p.id = o.pass_id AND p.org_id = o.org_id
     WHERE o.kind = ? AND o.created_at >= ? AND coalesce(p.mode, 'live') = ?
       AND (o.pass_id IS NULL OR p.id IS NOT NULL)${orgClause}${templateClause}${filter} GROUP BY t`,
    [
      w.bucketMs,
      w.bucketMs,
      kind,
      w.since,
      scope.mode,
      ...(scope.orgId ? [scope.orgId] : []),
      ...(scope.templateId ? [scope.templateId] : []),
    ],
  );
}

export async function syncRunRows(db: D1Database, w: Window, scope: Scope): Promise<SeriesRow[]> {
  // Connection sync events carry no template; do not attribute them to a template filter.
  if (scope.mode === 'test' || scope.templateId) return [];
  const join = scope.orgId ? 'JOIN connections c ON c.id = cr.connection_id' : '';
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('cr.started_at')} AS t, count(*) AS n FROM connection_runs cr ${join}
     WHERE cr.started_at >= ?${scope.orgId ? ' AND c.org_id = ?' : ''} GROUP BY t`,
    ordered(w, scope.orgId ? [scope.orgId] : []),
  );
}

export async function signInRows(db: D1Database, w: Window, scope: Scope): Promise<SeriesRow[]> {
  if (scope.mode === 'test' || scope.templateId) return [];
  return all<SeriesRow>(
    db,
    `SELECT ${bucket('at')} AS t, count(*) AS n FROM audit_log
     WHERE action LIKE 'auth.sign_in%' AND at >= ?${scope.orgId ? ' AND org_id = ?' : ''} GROUP BY t`,
    ordered(w, scope.orgId ? [scope.orgId] : []),
  );
}

export interface RecentRow {
  at: number;
  action: string;
  org_id: string | null;
  target_id: string | null;
}

/** Audit rows carry no mode, so test mode shows none, like the sign-in series. */
export async function recentAudit(db: D1Database, scope: Scope, limit: number, tenant: boolean) {
  // Audit entries have no reliable template dimension.
  if (scope.mode === 'test' || scope.templateId) return [];
  return all<RecentRow>(
    db,
    `SELECT at, action, org_id, ${tenant ? 'NULL AS target_id' : 'target_id'} FROM audit_log
     ${scope.orgId ? 'WHERE org_id = ?' : ''} ORDER BY at DESC LIMIT ?`,
    [...(scope.orgId ? [scope.orgId] : []), limit],
  );
}

export interface SetupCounts {
  orgs: number;
  assignedTemplates: number;
  passes: number;
  passEmailsSent: number;
  latestPassId: string | null;
}

/** First-run counts follow the requested org, template and checklist mode. */
export async function setupCounts(
  db: D1Database,
  scope?: Pick<Scope, 'orgId' | 'templateId'>,
  mode: Mode = 'live',
  includeLatest = true,
): Promise<SetupCounts> {
  const orgId = scope?.orgId;
  const templateId = scope?.templateId;
  const orgParams = orgId ? [orgId] : [];
  const templateParams = templateId ? [templateId] : [];
  const row = await first<Omit<SetupCounts, 'latestPassId'>>(
    db,
    `SELECT
       (SELECT count(*) FROM orgs WHERE status != 'deleted'${orgId ? ' AND id = ?' : ''}) AS orgs,
       (SELECT count(*) FROM templates WHERE org_id IS NOT NULL AND status != 'deleted'
         ${orgId ? 'AND org_id = ?' : ''}${templateId ? ' AND id = ?' : ''}) AS assignedTemplates,
       (SELECT count(*) FROM passes WHERE deleted_at IS NULL AND mode = ?
         ${orgId ? 'AND org_id = ?' : ''}${templateId ? ' AND template_id = ?' : ''}) AS passes,
       (SELECT count(*) FROM outbox o
         LEFT JOIN passes p ON p.id = o.pass_id AND p.org_id = o.org_id
         WHERE o.kind = 'email' AND o.state = 'sent' AND coalesce(p.mode, 'live') = ?
           AND (o.pass_id IS NULL OR p.id IS NOT NULL)
           ${orgId ? 'AND o.org_id = ?' : ''}${templateId ? ' AND p.template_id = ?' : ''})
         AS passEmailsSent`,
    [
      ...orgParams,
      ...(orgId ? [orgId] : []),
      ...templateParams,
      mode,
      ...orgParams,
      ...templateParams,
      mode,
      ...orgParams,
      ...templateParams,
    ],
  );
  const latest = includeLatest
    ? await first<{ id: string }>(
        db,
        `SELECT id FROM passes WHERE deleted_at IS NULL AND mode = ?
     ${orgId ? 'AND org_id = ?' : ''}${templateId ? ' AND template_id = ?' : ''}
     ORDER BY created_at DESC, id DESC LIMIT 1`,
        [mode, ...orgParams, ...templateParams],
      )
    : null;
  return {
    orgs: row?.orgs ?? 0,
    assignedTemplates: row?.assignedTemplates ?? 0,
    passes: row?.passes ?? 0,
    passEmailsSent: row?.passEmailsSent ?? 0,
    latestPassId: latest?.id ?? null,
  };
}
