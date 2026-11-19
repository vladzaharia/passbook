import type { Mode } from '../../../shared/contracts/common.ts';
import { type ScannerSettings, ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScannerAcceptsSchema } from '../../../shared/contracts/scanners.ts';
import type { SessionCustomerSettings as SessionCustomer } from '../../../shared/contracts/scanning-sessions.ts';
import {
  ScanDeviceCapabilitiesSchema,
  ScanDeviceOverridesSchema,
  ScanningDeviceSchema,
  ScanningSessionSchema,
  SessionCustomerSettingsSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { localDayStart } from './counts.ts';
import { parseSettings } from './dto-console.ts';
import { captureConsoleFeed } from './feed-console-page.ts';
import { scannerHasTemplates } from './repo-device.ts';
import { type ScanReadAuthority, scanReadAuthority } from './repo-read-authority.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionStats } from './repo-scanning-sessions.ts';
import {
  countOrgTemplates,
  readScannerScope,
  readValidEventScope,
  type ScanEventRow,
} from './repo-scope.ts';
import { activeHold, sessionWindow, storedHours } from './session-hours.ts';

/**
 * What a session read is authorized by: the org and mode, the session a device is bound to, and
 * the read fence at a clock reading (membership for the console, scanner for a device). The actor's
 * epochs were captured with it; nothing here carries a secret.
 */
export interface SessionReadAuthority {
  orgId: string;
  mode: Mode;
  /** Device authorities are restricted to their originally bound session. */
  sessionId?: string;
  /** Present only for a console read, bound to its exact membership and session. */
  tenant?: Extract<TenantPassWrite, { kind: 'session' }>;
  at(now: number): ScanReadAuthority;
}

/** Capture the console viewer's membership and session with the epochs the reads are fenced on. */
export async function captureConsoleSessionCountAuthority(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: TenantPassWrite,
): Promise<SessionReadAuthority> {
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
  const actor = await captureConsoleFeed(ctx, { ...session, roles: [...session.roles] }, original);
  if (!actor.role) throw new ForbiddenError();
  return {
    orgId: original.orgId,
    mode: original.mode,
    tenant: original,
    at: (now) => scanReadAuthority(actor, { now }),
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
    (scanner.eventId !== null || (await scannerHasTemplates(ctx.env.DB, scanner.id)))
  );
}

/** The session's customer-screen lines, kept beside the scanner settings (which strip them). */
export function storedCustomer(raw: string): { customer?: SessionCustomer } {
  try {
    const parsed = SessionCustomerSettingsSchema.safeParse(JSON.parse(raw).customer);
    return parsed.success ? { customer: parsed.data } : {};
  } catch {
    return {};
  }
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
  authority: SessionReadAuthority,
) {
  const settings = effectiveSessionSettings(row);
  const now = ctx.clock.now();
  const [scope, stats] = await Promise.all([
    resolveSessionScope(ctx, row),
    scanningSessionStats(
      ctx.env.DB,
      row,
      localDayStart(now, row.time_zone),
      now - 120_000,
      authority,
      now,
    ),
  ]);
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
      ? {
          ...settings,
          ...storedCustomer(row.settings),
          ...(scope.restricted ? { acceptAllTemplates: false } : {}),
        }
      : { ...parseSettings(row.settings), acceptAllTemplates: false, lookup: false },
    timeZone: row.time_zone,
    hours: ((h) => (h === 'invalid' ? null : h))(storedHours(row.hours)),
    hold: activeHold(row.hold, now),
    window: sessionWindow(row, now),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deviceCount: stats.devices,
    onlineCount: stats.online,
    today: stats.today,
  });
}

/** The session's devices as the console shows them, each with its scope as it holds now. */
export function sessionDeviceViews(
  ctx: ServiceContext,
  row: ScanningSessionRow,
  session: { settings: { acceptAllTemplates?: boolean } },
  scope: ResolvedSessionScope,
  devices: readonly ScanningDeviceRow[],
) {
  return Promise.all(
    devices.map(async (d) => {
      const settings = effectiveSessionSettings(row, d);
      const scanner = await getConsoleScanner(ctx.env.DB, d.scanner_id);
      const invalidScannerScope =
        !scanner ||
        scanner.mode !== row.mode ||
        !(await readScannerScope(ctx.env.DB, scanner, null)).valid;
      const conflict =
        !!scanner && !!settings && (await conflictsWithAllScope(ctx, scanner, scope, settings));
      return deviceDto(
        d,
        ctx.clock.now(),
        settings
          ? {
              ...settings,
              acceptAllTemplates:
                !invalidScannerScope && !conflict && session.settings.acceptAllTemplates === true,
            }
          : { ...parseSettings(d.settings), acceptAllTemplates: false, lookup: false },
      );
    }),
  );
}
