import { grant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { getOrgRow, type OrgRow } from './repo.ts';

/** Tenant writes are bound to the exact session and membership captured for this org. */
export type OrgWriteAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

const staleOrg = () =>
  new ConflictError('The organization changed. Reload and retry.', 'SETTINGS_CHANGED');

/**
 * One org edit derived from a read: it commits only while the org's `config_revision` is still the one
 * read (409 `SETTINGS_CHANGED`, not 403) and, with an `authority`, only while the actor is live and
 * holds `org:manage`. Access (`access_revision`) does not move with an edit, so a concurrent branding
 * or settings save never fails an unrelated request. Without an `authority` (the platform admin path,
 * guarded by its route) the CAS alone applies. Returns null when the org is gone or the capability is
 * not `org:manage`.
 */
async function writeOrg(
  ctx: ServiceContext,
  id: string,
  configRevision: number,
  columns: Record<string, string | null>,
  now: number,
  authority?: OrgWriteAuthority,
): Promise<OrgRow | null> {
  const db = ctx.env.DB;
  if (authority && (authority.orgId !== id || authority.capability !== 'org:manage')) return null;
  const names = Object.keys(columns);
  if (!authority) {
    const saved = await first<{ id: string }>(
      db,
      `UPDATE orgs SET ${names.map((c) => `${c} = ?`).join(', ')}, updated_at = MAX(updated_at + 1, ?)
       WHERE id = ? AND status != 'deleted' AND config_revision = ? RETURNING id`,
      [...Object.values(columns), now, id, configRevision],
    );
    if (saved) return getOrgRow(db, id);
    if (await getOrgRow(db, id)) throw staleOrg();
    return null;
  }
  const g = grant(ctx, {
    purpose: 'org.org.update',
    principal: tenantPrincipal(authority),
    target: id,
    checks: [
      ...capabilityChecks(authority),
      epochIs('orgs', id, 'config_revision', configRevision),
    ],
    codes: { config: 'SETTINGS_CHANGED' },
  });
  g.update('orgs', { set: { ...columns, updated_at: maxNow(now) }, where: {}, returning: ['id'] });
  const [result] = await g.commit();
  return result?.results.length ? getOrgRow(db, id) : null;
}

type OrgEdit = Pick<
  OrgRow,
  'id' | 'slug' | 'name' | 'status' | 'default_identity_id' | 'branding' | 'config_revision'
> & { updated_at: number };

export function updateOrgRow(
  ctx: ServiceContext,
  row: OrgEdit,
  authority?: OrgWriteAuthority,
): Promise<OrgRow | null> {
  const { slug, name, status, default_identity_id, branding } = row;
  return writeOrg(
    ctx,
    row.id,
    row.config_revision,
    { slug, name, status, default_identity_id, branding },
    row.updated_at,
    authority,
  );
}

/** Replaces only the branding of `before`. Same CAS and authority as `updateOrgRow`. */
export function saveOrgBranding(
  ctx: ServiceContext,
  before: OrgRow,
  branding: string,
  now: number,
  authority?: OrgWriteAuthority,
): Promise<OrgRow | null> {
  return writeOrg(ctx, before.id, before.config_revision, { branding }, now, authority);
}

/** A platform admin's live session: the principal of org create, status and delete. */
export interface OrgAdmin {
  userId: string;
  sessionId: string;
}

const adminPrincipal = (admin: OrgAdmin) =>
  ({ kind: 'platform', userId: admin.userId, sessionIdHash: admin.sessionId }) as const;

/** `platform.org.create`: commits only while the admin session is live. */
export async function insertOrgAsAdmin(
  ctx: ServiceContext,
  row: Omit<OrgRow, 'config_revision'>,
  admin: OrgAdmin,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'platform.org.create',
    principal: adminPrincipal(admin),
    target: row.id,
  });
  g.insertSelect(
    'orgs',
    ['id', 'slug', 'name', 'status', 'default_identity_id', 'branding', 'created_at', 'updated_at'],
    [
      row.id,
      row.slug,
      row.name,
      row.status,
      row.default_identity_id,
      row.branding,
      row.created_at,
      row.updated_at,
    ],
  );
  await g.commit();
}

/**
 * `platform.org.status` / `platform.org.delete`: the org moves from the status the caller read, while the
 * admin session is live. Scheduled broadcasts are cancelled by the `orgs_inactive_cancels_broadcasts` trigger.
 * False when the org was no longer in `from`.
 */
export async function moveOrgStatusAsAdmin(
  ctx: ServiceContext,
  id: string,
  from: OrgRow['status'],
  to: OrgRow['status'],
  admin: OrgAdmin,
): Promise<boolean> {
  const g = grant(ctx, {
    purpose: to === 'deleted' ? 'platform.org.delete' : 'platform.org.status',
    principal: adminPrincipal(admin),
    target: id,
  });
  g.update('orgs', {
    set: {
      status: to,
      ...(to === 'deleted' ? { default_identity_id: null } : {}),
      updated_at: maxNow(ctx.clock.now()),
    },
    where: { id, status: from },
    returning: ['id'],
  });
  const [result] = await g.commit();
  return (result?.results.length ?? 0) > 0;
}
