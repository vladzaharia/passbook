import type { Mode } from '../../../shared/contracts/common.ts';
import { type ScannerSettings, ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScannerAcceptsSchema } from '../../../shared/contracts/scanners.ts';
import {
  ScanDeviceCapabilitiesSchema,
  ScanDeviceOverridesSchema,
  ScanningDeviceSchema,
  ScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { SqlValue } from '../../platform/db.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { localDayStart } from './counts.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { parseSettings } from './dto-console.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { hasScannerTemplates } from './repo-scanner-configuration-scope.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionStats } from './repo-scanning-sessions.ts';
import { countOrgTemplates, readValidEventScope, type ScanEventRow } from './repo-scope.ts';

/** Request-local evidence; SQL secret binds must never be serialized into the DTO. */
export interface SessionCountAuthority {
  orgId: string;
  mode: Mode;
  /** Device authorities are restricted to their originally bound session. */
  sessionId?: string;
  /** Present only for a console proof, bound to its exact membership and session. */
  tenant?: Extract<TenantPassWrite, { kind: 'session' }>;
  credentialKeysetCommitment: string;
  guard: { sql: string; params: readonly SqlValue[] };
  guardAt(now: number): { sql: string; params: readonly SqlValue[] } | null;
}

/** Capture the original tenant session and CSRF proof before any count is read. */
export async function captureConsoleSessionCountAuthority(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: TenantPassWrite,
): Promise<SessionCountAuthority> {
  if (
    authority.kind !== 'session' ||
    authority.capability !== 'scanning:read' ||
    authority.userId !== session.userId ||
    authority.sessionId !== session.sessionId ||
    authority.mode !== session.mode
  )
    throw new ForbiddenError();
  const original = {
    ...authority,
    roles: [...authority.roles],
    sessionRoles: [...authority.sessionRoles],
  };
  const authenticated = { ...session, roles: [...session.roles] };
  const pinned = credentialKeysetContext(ctx);
  const [credentialKeysetCommitment, tenant] = await Promise.all([
    credentialRefKeysetCommitment(pinned.env),
    captureScanTenantAuthority(pinned, authenticated, original),
  ]);
  const actor = adminActor(authenticated, original.mode, {
    orgId: original.orgId,
    event: null,
    templateIds: [],
    timeZone: 'UTC',
  });
  actor.tenantAuthority = tenant;
  actor.platformSessionId = authenticated.sessionId;
  actor.role = tenantScanRole(tenant);
  if (!actor.role) throw new ForbiddenError();
  const csrfStmt = actorCsrfAuthorityStmt(pinned.env.DB, actor);
  const snapshot = await actorCsrfSnapshotFromResult(
    pinned,
    actor,
    csrfStmt ? await csrfStmt.all() : undefined,
  );
  if (!snapshot) throw new ForbiddenError();
  const guardAt = (now: number) => {
    const csrf = actorCsrfSnapshotFence(actor, {
      ...snapshot,
      session: snapshot.session ? { ...snapshot.session, now } : null,
    });
    if (!csrf) return null;
    const current = actorAuthorityPredicate({
      actor,
      now,
      event: null,
      adminEventTemplates: false,
    });
    return {
      sql: `(${current.sql}) AND (${csrf.sql})`,
      params: [...current.params, ...csrf.params],
    };
  };
  const guard = guardAt(ctx.clock.now());
  if (!guard) throw new ForbiddenError();
  return {
    orgId: original.orgId,
    mode: original.mode,
    tenant: original,
    credentialKeysetCommitment,
    guard,
    guardAt,
  };
}

type SessionAccepts = { eventId: string } | { templateIds: string[] } | null;
type ResolvedSessionScope = {
  accepts: SessionAccepts;
  event: ScanEventRow | null;
  templateIds: string[];
  restricted: boolean;
  valid: boolean;
};

/** A configured scope is never treated as "all" merely because it cannot be resolved. */
export async function resolveSessionScope(
  ctx: ServiceContext,
  row: ScanningSessionRow,
): Promise<ResolvedSessionScope> {
  const invalid: ResolvedSessionScope = {
    accepts: null,
    event: null,
    templateIds: [],
    restricted: true,
    valid: false,
  };
  if (row.accepts === null)
    return { accepts: null, event: null, templateIds: [], restricted: false, valid: true };
  let raw: unknown;
  try {
    raw = JSON.parse(row.accepts);
  } catch {
    return invalid;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1)
    return invalid;
  const parsed = ScannerAcceptsSchema.safeParse(raw);
  if (!parsed.success) return invalid;
  if ('eventId' in parsed.data) {
    const scope = await readValidEventScope(ctx.env.DB, row.org_id, row.mode, parsed.data.eventId);
    if (!scope) return invalid;
    return {
      accepts: { eventId: scope.event.id },
      event: scope.event,
      templateIds: scope.templateIds,
      restricted: true,
      valid: true,
    };
  }
  const templateIds = [...new Set(parsed.data.templateIds)];
  if (
    (await countOrgTemplates(ctx.env.DB, row.org_id, row.mode, templateIds)) !== templateIds.length
  )
    return invalid;
  return { accepts: { templateIds }, event: null, templateIds, restricted: true, valid: true };
}

/** A stale device-side restriction must not become an unrestricted session. */
export async function conflictsWithAllScope(
  ctx: ServiceContext,
  scanner: { id: string; eventId: string | null },
  scope: ResolvedSessionScope,
  settings: ScannerSettings,
): Promise<boolean> {
  return (
    !scope.restricted &&
    settings.acceptAllTemplates === true &&
    (scanner.eventId !== null || (await hasScannerTemplates(ctx.env.DB, scanner.id)))
  );
}

export function effectiveSessionSettings(
  session: ScanningSessionRow,
  device?: ScanningDeviceRow | null,
): ScannerSettings | null {
  try {
    const overrides = ScanDeviceOverridesSchema.safeParse(
      device ? JSON.parse(device.overrides) : {},
    );
    if (!overrides.success) return null;
    const settings = ScannerSettingsSchema.safeParse({
      ...JSON.parse(session.settings),
      ...overrides.data,
    });
    return settings.success ? settings.data : null;
  } catch {
    return null;
  }
}

export function projectedDeviceSettings(
  session: ScanningSessionRow,
  device: ScanningDeviceRow,
  scope: ResolvedSessionScope,
): ScannerSettings {
  const settings = effectiveSessionSettings(session, device);
  if (!settings)
    return { ...parseSettings(device.settings), acceptAllTemplates: false, lookup: false };
  return scope.restricted ? { ...settings, acceptAllTemplates: false } : settings;
}

export const deviceDto = (row: ScanningDeviceRow, now: number, settings?: ScannerSettings) =>
  ScanningDeviceSchema.parse({
    id: row.scanner_id,
    sessionId: row.session_id,
    name: row.name,
    surface: row.surface,
    effectiveSurface: row.effective_surface,
    overrides: JSON.parse(row.overrides),
    settings: settings ?? parseSettings(row.settings),
    capabilities: row.capabilities
      ? ScanDeviceCapabilitiesSchema.parse(JSON.parse(row.capabilities))
      : null,
    reportedAt: row.reported_at,
    paired: !!row.token_hash || !!row.admin_user_id,
    online:
      row.revoked_at === null && row.last_seen_at !== null && now - row.last_seen_at < 120_000,
    revoked: row.revoked_at !== null,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    signIn: row.admin_user_id ? 'admin' : 'paired',
    adminName: row.admin_user_id ? row.admin_name : null,
  });
export async function sessionDto(
  ctx: ServiceContext,
  row: ScanningSessionRow,
  authority: SessionCountAuthority,
) {
  const scope = await resolveSessionScope(ctx, row);
  const settings = effectiveSessionSettings(row);
  const now = ctx.clock.now();
  const stats = await scanningSessionStats(
    ctx.env.DB,
    row,
    localDayStart(now, row.time_zone),
    now - 120_000,
    authority,
    now,
  );
  if (!stats) throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return ScanningSessionSchema.parse({
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    mode: row.mode,
    name: row.name,
    status: row.status,
    accepts: settings ? scope.accepts : null,
    settings: settings
      ? { ...settings, ...(scope.restricted ? { acceptAllTemplates: false } : {}) }
      : { ...parseSettings(row.settings), acceptAllTemplates: false, lookup: false },
    timeZone: row.time_zone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deviceCount: stats.devices,
    onlineCount: stats.online,
    today: stats.today,
  });
}
