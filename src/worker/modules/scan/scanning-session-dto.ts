import type { Mode } from '../../../shared/contracts/common.ts';
import { type ScannerSettings, ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import {
  ADMITS_TEMPLATE_CAP,
  type AdmitsInput,
  admitsWire,
} from '../../../shared/contracts/scanners.ts';
import type { SessionCustomerSettings as SessionCustomer } from '../../../shared/contracts/scanning-sessions.ts';
import {
  ScanDeviceOverridesSchema,
  ScanningDeviceSchema,
  ScanningSessionSchema,
  SessionCustomerSettingsSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { readStoredCapabilities } from '../../../shared/stored-capabilities.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { storedAdmits } from './admits.ts';
import { localDayStart } from './counts.ts';
import { parseSettings } from './dto-console.ts';
import { captureConsoleFeed } from './feed-console-page.ts';
import { scannerHasTemplates } from './repo-device.ts';
import {
  keyScanReadAuthority,
  type ScanReadAuthority,
  scanReadAuthority,
} from './repo-read-authority.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionStats } from './repo-scanning-sessions.ts';
import {
  countOrgTemplates,
  type EventScope,
  readScannerScope,
  readValidEventScope,
  type ScanEventRow,
} from './repo-scope.ts';
import { readValidEventScopes } from './repo-scope-events.ts';
import { hash53 } from './scan-epochs.ts';
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
  /** An org-bound API key read: counts and rules, no activity feed. */
  key?: true;
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

/** The count fence of an org-bound `scan-setup:read` key: its own live row, scope and org, no console session. */
export function keySessionCountAuthority(
  authority: Extract<TenantPassWrite, { kind: 'api_key' }>,
): SessionReadAuthority {
  keyScanReadAuthority(authority, 0);
  return {
    orgId: authority.orgId,
    mode: authority.mode,
    key: true,
    at: (now) => keyScanReadAuthority(authority, now),
  };
}

export type ResolvedSessionScope = {
  /** The session's admits as the DTO shows them. */
  accepts: AdmitsInput | null;
  event: ScanEventRow | null;
  templateIds: string[];
  /** Only on a mixed scope; see `ScanActor.events`. */
  events?: EventScope[];
  entryTemplateIds?: string[];
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
  const admits = storedAdmits(row.accepts);
  if (admits === null)
    return { accepts: null, event: null, templateIds: [], restricted: false, valid: true };
  if (!admits) return invalid;
  const db = ctx.env.DB;
  const entries = admits.templateIds;
  if (
    entries.length > 0 &&
    (await countOrgTemplates(db, row.org_id, row.mode, entries)) !== entries.length
  )
    return invalid;
  const accepts = admitsWire(admits);
  const [only] = admits.eventIds;
  if (only !== undefined && admits.eventIds.length === 1 && entries.length === 0) {
    const scope = await readValidEventScope(db, row.org_id, row.mode, only);
    if (!scope) return invalid;
    const { event, templateIds } = scope;
    return { accepts, event, templateIds, restricted: true, valid: true };
  }
  if (admits.eventIds.length === 0)
    return { accepts, event: null, templateIds: entries, restricted: true, valid: true };
  const events = await readValidEventScopes(db, row.org_id, row.mode, admits.eventIds);
  if (!events) return invalid;
  const templateIds = [...new Set([...entries, ...events.flatMap((e) => e.templateIds)])];
  if (templateIds.length > ADMITS_TEMPLATE_CAP) return invalid;
  return {
    accepts,
    event: null,
    templateIds,
    events,
    entryTemplateIds: entries,
    restricted: true,
    valid: true,
  };
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

/** A digest of what an admin edits (name, surface, overrides): a device's own writes (staff sign-in, heartbeat) never move it. */
export const deviceConfigRevision = (row: ScanningDeviceRow): number =>
  hash53(JSON.stringify([row.name, row.surface, row.overrides]));

export const deviceDto = (row: ScanningDeviceRow, now: number, settings?: ScannerSettings) =>
  ScanningDeviceSchema.parse({
    id: row.scanner_id,
    sessionId: row.session_id,
    name: row.name,
    surface: row.surface,
    effectiveSurface: row.effective_surface,
    overrides: JSON.parse(row.overrides),
    settings: settings ?? parseSettings(row.settings),
    capabilities: readStoredCapabilities(row.capabilities),
    reportedAt: row.reported_at,
    paired: !!row.token_hash || !!row.admin_user_id,
    online:
      row.revoked_at === null && row.last_seen_at !== null && now - row.last_seen_at < 120_000,
    revoked: row.revoked_at !== null,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    configRevision: deviceConfigRevision(row),
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
  const hours = storedHours(row.hours);
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
    hours: hours === 'invalid' ? null : hours,
    ...(hours === 'invalid' ? { hoursInvalid: true } : {}),
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
