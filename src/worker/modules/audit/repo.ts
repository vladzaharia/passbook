import { OrgRoleSchema } from '../../../shared/contracts/org-membership.ts';
import { all, prefixMatch, run, type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail, safeLabel } from './redact.ts';
import type { AuditEntry } from './types.ts';

export interface AuditRow {
  id: number;
  at: number;
  org_id: string | null;
  actor_type: 'user' | 'api_key' | 'system' | 'connection' | 'device' | 'scanner';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  detail: string | null;
}

export interface AuditFilter {
  orgId?: string;
  /** Present only for a tenant read, after checking the membership's capabilities. */
  tenant?: { userId: string; membershipId: string };
  actorId?: string;
  /** Prefix match. */
  action?: string;
  /** Prefix to leave out. */
  excludeAction?: string;
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
  /** Exclusive upper bound on id (newest first paging). */
  before?: number;
}

export async function listAuditRows(
  db: D1Database,
  filter: AuditFilter,
  limit: number,
): Promise<AuditRow[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, value: SqlValue) => {
    where.push(clause);
    params.push(value);
  };
  if (filter.orgId) add('org_id = ?', filter.orgId);
  if (filter.tenant) {
    // Membership roles are immutable; recheck this exact authorization at the row read.
    where.push(`EXISTS (
      SELECT 1 FROM org_memberships reader
      JOIN users reader_user ON reader_user.id = reader.user_id AND reader_user.status = 'active'
      JOIN orgs reader_org ON reader_org.id = reader.org_id AND reader_org.status = 'active'
      WHERE reader.id = ? AND reader.user_id = ? AND reader.org_id = audit_log.org_id
        AND reader.revoked_at IS NULL
    )`);
    params.push(filter.tenant.membershipId, filter.tenant.userId);
    if (filter.actorId) where.push(tenantRefPredicate('actor_type', 'actor_id'));
    if (filter.targetId) where.push(tenantRefPredicate('target_type', 'target_id'));
  }
  if (filter.actorId) add('actor_id = ?', filter.actorId);
  if (filter.action) {
    const match = prefixMatch('action', filter.action);
    where.push(match.sql);
    params.push(...match.params);
  }
  if (filter.excludeAction) {
    const match = prefixMatch('action', filter.excludeAction);
    where.push(`NOT (${match.sql})`);
    params.push(...match.params);
  }
  if (filter.targetType) add('target_type = ?', filter.targetType);
  if (filter.targetId) add('target_id = ?', filter.targetId);
  if (filter.from !== undefined) add('at >= ?', filter.from);
  if (filter.to !== undefined) add('at <= ?', filter.to);
  if (filter.before !== undefined) add('id < ?', filter.before);
  const sql = `SELECT id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, detail
     FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return all<AuditRow>(db, sql, [...params, limit]);
}

/** Deletes up to `limit` rows older than the cutoff; returns how many went. */
export async function deleteAuditBefore(
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY at LIMIT ?)',
    [cutoff, limit],
  );
  return changes;
}

interface LabelSource {
  table: string;
  id: string;
  expr: string;
  scope(org: string): string;
}

const MEMBER_ROLES = OrgRoleSchema.options.map((role) => `'${role}'`).join(',');
const memberScope = (org: string) => `entity.status = 'active' AND EXISTS (
  SELECT 1 FROM org_memberships member
  WHERE member.user_id = entity.id AND member.org_id = ${org} AND member.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(member.roles) role
      WHERE role.type != 'text' OR role.value NOT IN (${MEMBER_ROLES}))
    AND (SELECT count(*) FROM json_each(member.roles)) =
        (SELECT count(DISTINCT value) FROM json_each(member.roles))
)`;
const orgScope = (org: string) => `entity.org_id = ${org}`;
const LABEL_SOURCES: Record<string, LabelSource> = {
  user: { table: 'users', id: 'id', expr: 'name', scope: memberScope },
  pass: { table: 'passes', id: 'id', expr: 'display_title', scope: orgScope },
  org: { table: 'orgs', id: 'id', expr: 'name', scope: (org) => `entity.id = ${org}` },
  template: { table: 'templates', id: 'id', expr: 'name', scope: orgScope },
  connection: { table: 'connections', id: 'id', expr: 'name', scope: orgScope },
  api_key: { table: 'api_keys', id: 'id', expr: 'name', scope: orgScope },
  identity: { table: 'signing_identities', id: 'id', expr: 'label', scope: orgScope },
  scanner: { table: 'scanners', id: 'id', expr: 'NULL', scope: orgScope },
  scan_event: { table: 'scan_events', id: 'id', expr: 'NULL', scope: orgScope },
  scan_staff: { table: 'scan_staff', id: 'id', expr: 'NULL', scope: orgScope },
  scanning_session: { table: 'scanning_sessions', id: 'id', expr: 'NULL', scope: orgScope },
  broadcast: { table: 'broadcasts', id: 'id', expr: 'NULL', scope: orgScope },
  bundle: { table: 'bundles', id: 'id', expr: 'NULL', scope: orgScope },
  template_import: { table: 'template_imports', id: 'upload_id', expr: 'NULL', scope: orgScope },
  org_invitation: { table: 'org_invitations', id: 'id', expr: 'NULL', scope: orgScope },
  org_membership: { table: 'org_memberships', id: 'id', expr: 'NULL', scope: orgScope },
};

export const labelKey = (type: string, id: string) => `${type}:${id}`;

/** Filtered reference IDs must be visible too, or the filter becomes an identity oracle. */
function tenantRefPredicate(typeColumn: string, idColumn: string): string {
  const cases = Object.entries(LABEL_SOURCES).map(
    ([type, source]) =>
      `(audit_log.${typeColumn} = '${type}' AND EXISTS (SELECT 1 FROM ${source.table} entity
        WHERE entity.${source.id} = audit_log.${idColumn} AND ${source.scope('audit_log.org_id')}))`,
  );
  cases.push(
    `(audit_log.${typeColumn} = 'settings' AND audit_log.${idColumn} = 'org:' || audit_log.org_id)`,
  );
  return `(${cases.join(' OR ')})`;
}

/** Resolve only references visible to the tenant; null labels still prove ownership. */
export async function loadLabels(
  db: D1Database,
  refs: { type: string; id: string }[],
  orgId?: string,
): Promise<Map<string, string | null>> {
  const byType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!Object.hasOwn(LABEL_SOURCES, ref.type)) continue;
    byType.set(ref.type, (byType.get(ref.type) ?? new Set()).add(ref.id));
  }
  const labels = new Map<string, string | null>();
  if (orgId && refs.some((ref) => ref.type === 'settings' && ref.id === `org:${orgId}`))
    labels.set(labelKey('settings', `org:${orgId}`), null);
  for (const [type, ids] of byType) {
    const source = LABEL_SOURCES[type];
    if (!source) continue;
    const list = [...ids];
    // D1 limits bound parameters; reserve one slot for the tenant organization.
    for (let offset = 0; offset < list.length; offset += 90) {
      const chunk = list.slice(offset, offset + 90);
      const rows = await all<{ id: string; label: string | null }>(
        db,
        `SELECT entity.${source.id} AS id, ${source.expr === 'NULL' ? 'NULL' : `entity.${source.expr}`} AS label
         FROM ${source.table} entity WHERE entity.${source.id} IN (${chunk.map(() => '?').join(',')})
         ${orgId ? `AND ${source.scope('?')}` : ''}`,
        orgId ? [...chunk, orgId] : chunk,
      );
      for (const row of rows) labels.set(labelKey(type, row.id), safeLabel(row.label));
    }
  }
  return labels;
}

/**
 * The audit INSERT as a statement, so a mutation and its audit row commit in one `db.batch`.
 * Detail is redacted here as a backstop.
 */
export function auditStmt(
  db: D1Database,
  ctx: Pick<ServiceContext, 'clock' | 'requestId'>,
  entry: AuditEntry,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.clock.now(),
      entry.orgId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      ctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
    ],
  );
}
