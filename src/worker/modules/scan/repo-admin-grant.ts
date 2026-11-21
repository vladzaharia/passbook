import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import { type Check, epochIs, templateUsableSql } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { tagged } from './setup-check-merge.ts';

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

export const SETUP_APPLY = 'org_mode.scan.setup.apply';

/** An API key that holds `scanning:write` for this org (the scan setup of a template). */
export type KeyAdminAuthority = Extract<TenantPassWrite, { kind: 'api_key' }>;

/** The scan admin grants a key may hold: the writes of a template's scan setup, and the one-call setup (which refuses zones and staff for a key). */
const KEY_PURPOSES: ReadonlySet<string> = new Set([
  'org_mode.scan.event.create',
  'org_mode.scan.event.archive',
  'org_mode.scan.event.update',
  'org_mode.scan.session.create',
  'org_mode.scan.session.update',
  'org_mode.scan.session.hold',
  'org_mode.scan.device.update',
  'org_mode.scan.event.assign',
  'org_mode.scan.visits.reset',
  SETUP_APPLY,
  'org.scan.zone.create',
  'org.scan.zone.update',
]);

/**
 * Who a scan admin grant acts as: the console session (`adminAuthorityOf`), or a key whose verified
 * scope is `scanning:write`, for the purposes in `KEY_PURPOSES` only (pairing, staff PINs and admin
 * sessions stay human). `actorId` is the user id or the key id; the grant re-derives the scope
 * from the key's own row (scopes, roles, expiry, retirement) at commit. Without a `purpose` a key
 * is accepted only to read a target (`loadManageEvent`): the write that follows names its own.
 */
export function grantAuthorityOf(
  authority: TenantPassWrite | null | undefined,
  actorId: string,
  orgId: string,
  purpose?: string,
): AdminAuthority | KeyAdminAuthority {
  if (authority?.kind !== 'api_key') return adminAuthorityOf(authority, actorId, orgId);
  const admin = authority.scope === 'scanning:admin';
  if (
    (purpose !== undefined && !KEY_PURPOSES.has(purpose)) ||
    // `scanning:admin` (staff PINs, pairing codes) serves the one-call setup only, for an org-bound live key.
    (admin &&
      (purpose !== SETUP_APPLY || authority.keyOrgId !== orgId || authority.mode !== 'live')) ||
    (!admin && authority.scope !== 'scanning:write') ||
    // Zones belong to the org, not a mode: only a live key writes them.
    (purpose?.startsWith('org.scan.zone.') === true && authority.mode !== 'live') ||
    authority.keyId !== actorId ||
    authority.orgId !== orgId
  )
    throw new ForbiddenError();
  return authority;
}

/** The audit actor of a scan admin write: the user, or the key. */
export const adminActorOf = (authority: TenantPassWrite, actorId: string) =>
  ({ actorType: authority.kind === 'api_key' ? 'api_key' : 'user', actorId }) as const;

/** `created_by` references a user: a key leaves it empty and is named by the audit row instead. */
export const createdByOf = (authority: TenantPassWrite, actorId: string): string | null =>
  authority.kind === 'api_key' ? null : actorId;

/** Every table a scan admin grant writes: the typed ones and the scanner template and setup parts. */
const SCAN_ADMIN_TABLES = [
  'scan_events',
  'scan_event_templates',
  'scan_staff',
  'scanners',
  'scanning_sessions',
  'scanning_devices',
  'scan_zones',
  'scanning_session_zones',
  'scanner_templates',
  'scanner_setups',
] as const;

/**
 * The tables the one-call setup grant may write, by caller: a console session all of them; a
 * `scanning:write` key neither staff nor, in test mode, zones (both are org-wide, not moded); a
 * live org-bound `scanning:admin` key all of them. The grant refuses the rest itself.
 */
export function setupTables(authority: TenantPassWrite): readonly string[] {
  if (authority.kind === 'session') return SCAN_ADMIN_TABLES;
  const live = authority.mode === 'live';
  const admin = authority.scope === 'scanning:admin' && live && authority.keyOrgId !== null;
  return SCAN_ADMIN_TABLES.filter(
    (t) => (t !== 'scan_staff' || admin) && (t !== 'scan_zones' || live),
  );
}

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
  tables: readonly string[] = SCAN_ADMIN_TABLES,
): Grant {
  const admin = grantAuthorityOf(authority, userId, orgId, purpose);
  return grant(ctx, {
    purpose,
    principal: tenantPrincipal(admin),
    checks: [...capabilityChecks(admin), ...checks],
    tables: [...tables],
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
export const eventsOpen = (ids: readonly (string | null | undefined)[]): Check[] => {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  // One bind for any count: the one-call setup puts every door's events in one grant row.
  return unique.length === 0
    ? []
    : [
        tagged(
          tenantCheck(
            'config',
            `NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM scan_events e
            WHERE e.id = j.value AND e.archived_at IS NULL AND e.org_id = {org} AND e.mode = {mode}))`,
            [JSON.stringify(unique)],
          ),
          'events',
          unique,
        ),
      ];
};

const TEMPLATE_STATUS = {
  active: templateUsableSql('t', 'issue'),
  attached: templateUsableSql('t', 'existing'),
} as const;

/**
 * Every template belongs to this org or the platform (one bind, any count) and is `active` (a new
 * attachment) or `attached` (already on the scope: archived keeps scanning, deleted stops).
 */
export function templatesUsable(
  ids: readonly string[],
  status: keyof typeof TEMPLATE_STATUS = 'active',
): Check[] {
  if (ids.length === 0) return [];
  return [
    tagged(
      tenantCheck(
        'config',
        `NOT EXISTS (SELECT 1 FROM json_each(?) j
        WHERE NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = j.value AND ${TEMPLATE_STATUS[status]}
          AND (t.org_id IS NULL OR t.org_id = {org})))`,
        [JSON.stringify([...new Set(ids)])],
      ),
      `templates:${status}`,
      [...new Set(ids)],
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

/** The sessions of the grant's org and mode admitting the event are exactly these. */
export function eventSessionsAre(eventId: string, ids: readonly string[]): Check {
  return tenantCheck(
    'config',
    `(SELECT COALESCE(group_concat(x.id), '') FROM (SELECT ss.id FROM scanning_sessions ss
      WHERE ss.org_id = {org} AND ss.mode = {mode} AND EXISTS (SELECT 1 FROM scan_events e
        WHERE e.id = ? AND e.org_id = {org} AND e.mode = {mode}
          AND (json_extract(ss.accepts, '$.eventId') = e.id
            OR EXISTS (SELECT 1 FROM json_each(ss.accepts, '$.eventIds') j WHERE j.value = e.id)))
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
