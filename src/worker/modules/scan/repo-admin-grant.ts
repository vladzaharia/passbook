import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import { type Check, epochIs, exactlyOne } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

export type AdminAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

/** `org_mode`: the request's mode is the row's mode. `org`: staff (no mode) and the mode move itself. */
export type ScanPurpose = `org_mode.scan.${string}` | `org.scan.${string}`;

/**
 * The console admin: the captured tenant session, which must hold scanning:manage for this org and
 * be this user. The capability comes from the membership's immutable roles (re-derived in the grant).
 */
export function adminAuthorityOf(
  authority: TenantPassWrite | null | undefined,
  userId: string,
  orgId: string,
): AdminAuthority {
  if (
    authority?.kind !== 'session' ||
    authority.capability !== 'scanning:manage' ||
    authority.userId !== userId ||
    authority.orgId !== orgId
  )
    throw new ForbiddenError();
  return authority;
}

export const adminPrincipal = (authority: AdminAuthority): Principal => tenantPrincipal(authority);

/** Every table a scan admin grant writes: the typed ones and the scanner template and setup parts. */
const SCAN_ADMIN_TABLES = [
  'scan_events',
  'scan_event_templates',
  'scan_staff',
  'scanners',
  'scanning_sessions',
  'scanning_devices',
  'scanner_templates',
  'scanner_setups',
] as const;

/** Any captured tenant session, whatever its capability (a read that fills a cache). */
export function sessionGrant(
  ctx: ServiceContext,
  purpose: ScanPurpose,
  authority: AdminAuthority,
  checks: Check[] = [],
  target?: string,
): Grant {
  return grant(ctx, {
    purpose,
    principal: adminPrincipal(authority),
    checks: [...capabilityChecks(authority), ...checks],
    tables: SCAN_ADMIN_TABLES,
    ...(target ? { target } : {}),
  });
}

export function adminGrant(
  ctx: ServiceContext,
  purpose: ScanPurpose,
  userId: string,
  authority: TenantPassWrite | null | undefined,
  orgId: string,
  checks: Check[] = [],
  codes?: DenialOptions['codes'],
  target?: string,
): Grant {
  const admin = adminAuthorityOf(authority, userId, orgId);
  return grant(ctx, {
    purpose,
    principal: adminPrincipal(admin),
    checks: [...capabilityChecks(admin), ...checks],
    tables: SCAN_ADMIN_TABLES,
    ...(codes ? { codes } : {}),
    ...(target ? { target } : {}),
  });
}

export const audited = (g: Grant, ctx: ServiceContext, entry: AuditEntry): GrantedStatement =>
  grantedAudit(g, ctx, entry);

/** The scanner still has the configuration epoch the edit was derived from. */
export const scannerEpoch = (id: string, epoch: number): Check =>
  epochIs('scanners', id, 'config_epoch', epoch);

export const sessionEpoch = (id: string, epoch: number): Check =>
  epochIs('scanning_sessions', id, 'config_epoch', epoch);

export const eventEpoch = (id: string, epoch: number): Check =>
  epochIs('scan_events', id, 'config_epoch', epoch);

/** Events the configuration points at exist in the grant's org and mode and are not archived. */
export const eventsOpen = (ids: readonly (string | null | undefined)[]): Check[] =>
  [...new Set(ids.filter((id): id is string => !!id))].map((id) =>
    exactlyOne('scan_events', { id, archived_at: null }, undefined, 'config'),
  );

const TEMPLATE_STATUS = {
  active: "t.status = 'active'",
  attached: "t.status != 'deleted'",
  archived: "t.status = 'archived'",
} as const;

/**
 * Every template belongs to this org or the platform (one bind, any count) and is `active` (a new
 * attachment), `attached` (already on the scope: archived keeps scanning, deleted stops) or
 * still `archived` (an attached template without an issuance head).
 */
export function templatesUsable(
  ids: readonly string[],
  status: keyof typeof TEMPLATE_STATUS = 'active',
): Check[] {
  if (ids.length === 0) return [];
  return [
    tenantCheck(
      'config',
      `NOT EXISTS (SELECT 1 FROM json_each(?) j
        WHERE NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = j.value AND ${TEMPLATE_STATUS[status]}
          AND (t.org_id IS NULL OR t.org_id = {org})))`,
      [JSON.stringify([...new Set(ids)])],
    ),
  ];
}

/** A scope's templates: ones `attached` already may be archived (never deleted); new ones are active. */
export const scopeTemplatesUsable = (
  ids: readonly string[],
  attached: readonly string[],
): Check[] => [
  ...templatesUsable(ids.filter((id) => !attached.includes(id))),
  ...templatesUsable(
    ids.filter((id) => attached.includes(id)),
    'attached',
  ),
];

/** The scanners of the grant's org and mode pointing at the event are exactly these. */
export function eventScannersAre(eventId: string, ids: readonly string[]): Check {
  return tenantCheck(
    'config',
    `(SELECT COALESCE(group_concat(x.id), '') FROM (SELECT s.id FROM scanners s
      WHERE s.event_id = ? AND s.org_id = {org} AND s.mode = {mode} ORDER BY s.id) x) = ?`,
    [eventId, [...ids].sort().join(',')],
  );
}

/** The sessions of the grant's org and mode accepting the event are exactly these. */
export function eventSessionsAre(eventId: string, ids: readonly string[]): Check {
  return tenantCheck(
    'config',
    `(SELECT COALESCE(group_concat(x.id), '') FROM (SELECT ss.id FROM scanning_sessions ss
      WHERE ss.org_id = {org} AND ss.mode = {mode} AND EXISTS (SELECT 1 FROM scan_events e
        WHERE e.id = ? AND e.org_id = {org} AND e.mode = {mode}
          AND json_extract(ss.accepts, '$.eventId') = e.id)
      ORDER BY ss.id) x) = ?`,
    [eventId, [...ids].sort().join(',')],
  );
}

/** Every scanner is in the grant's org and mode and can still take an event: a scan device that is not revoked. */
export function scannersAssignable(ids: readonly string[]): Check[] {
  if (ids.length === 0) return [];
  return [
    tenantCheck(
      'config',
      `NOT EXISTS (SELECT 1 FROM json_each(?) j
        WHERE NOT EXISTS (SELECT 1 FROM scanners s WHERE s.id = j.value AND s.org_id = {org}
          AND s.mode = {mode} AND s.device_role = 'scan' AND s.revoked_at IS NULL))`,
      [JSON.stringify([...new Set(ids)])],
    ),
  ];
}
