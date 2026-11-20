import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type CreateScanningSessionSchema,
  ScanningSessionSettingsSchema,
  type UpdateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantScanRole } from './actor.ts';
import { admitsJson } from './admits.ts';
import { kickScreen } from './live.ts';
import { noteSessionChange, savedOfflineSettings } from './offline-policy.ts';
import {
  adminActorOf,
  adminGrant,
  audited,
  eventsOpen,
  scopeTemplatesUsable,
  sessionEpoch,
} from './repo-admin-grant.ts';
import { addSessionPropagation, sessionDevicesAre } from './repo-scanner-configuration-sync.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import {
  addScanningSessionUpdate,
  type ScanningSessionRow,
  scanningSessionRow,
} from './repo-scanning-sessions.ts';
import { addSessionZones, sessionZoneIds } from './repo-zones.ts';
import { acceptedTemplateIds, checkAccepts } from './scanner-validation.ts';
import {
  assertSessionReadAuthority,
  assertSessionWriteCountAuthority,
} from './scanning-session-authority.ts';
import {
  effectiveSessionSettings,
  resolveSessionScope,
  type SessionReadAuthority,
  sessionDeviceViews,
  sessionDto,
  storedCustomer,
} from './scanning-session-dto.ts';
import { insertScanningSession, SESSION_CODES } from './scanning-session-insert.ts';
import { scanningSessionActivity } from './session-activity.ts';
import { addHoursAudit, timingPatch } from './session-hours-write.ts';
import {
  assertNoZonesLeft,
  eventOfAccepts,
  eventOnly,
  sessionZoneChecks,
} from './session-zones.ts';

export { startAdminSetup } from './scanning-session-admin-setup.ts';

export async function loadScanningSession(
  ctx: ServiceContext,
  id: string,
  mode?: Mode,
  orgId: string | null = null,
) {
  const row = await scanningSessionRow(ctx.env.DB, orgId, id);
  if (!row || (mode !== undefined && row.mode !== mode))
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return row;
}
export async function scanningSessionDetail(
  ctx: ServiceContext,
  id: string,
  mode: Mode,
  authority: TenantPassWrite,
  countAuthority: SessionReadAuthority,
) {
  assertSessionReadAuthority(mode, authority, countAuthority);
  return scanningSessionDetailForAuthority(ctx, id, mode, countAuthority);
}

export async function scanningSessionDetailForAuthority(
  ctx: ServiceContext,
  id: string,
  mode: Mode,
  countAuthority: SessionReadAuthority,
) {
  const row = await loadScanningSession(ctx, id, mode, countAuthority.orgId);
  const [session, devices, scope, zoneIds] = await Promise.all([
    sessionDto(ctx, row, countAuthority),
    scanningDeviceRows(ctx.env.DB, row.org_id, id),
    resolveSessionScope(ctx, row),
    sessionZoneIds(ctx.env.DB, row.org_id, id),
  ]);
  const deviceViews = await sessionDeviceViews(ctx, row, session, scope, devices);
  const role = countAuthority.tenant ? tenantScanRole(countAuthority.tenant) : null;
  if (!role) throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  // A scope that resolves to nothing has no provable activity; the session stays viewable to fix it.
  const activity = scope.valid
    ? await scanningSessionActivity(ctx, row, countAuthority, role, true)
    : [];
  if (activity === null)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return { ...session, zoneIds, devices: deviceViews, activity };
}
export async function createScanningSession(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanningSessionSchema>,
  authority: TenantPassWrite,
  countAuthority: SessionReadAuthority,
  /** Scan passes: the template this session is for. One live session per template (unique index). */
  setupTemplateId?: string,
) {
  assertSessionWriteCountAuthority(userId, authority, countAuthority);
  if (countAuthority.orgId !== input.orgId || countAuthority.mode !== mode)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  const id = await insertScanningSession(ctx, userId, mode, input, authority, setupTemplateId);
  return scanningSessionDetailForAuthority(ctx, id, mode, countAuthority);
}

export async function updateScanningSession(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScanningSessionSchema>,
  authority: TenantPassWrite,
  countAuthority: SessionReadAuthority,
) {
  assertSessionWriteCountAuthority(userId, authority, countAuthority);
  const row = await applyScanningSessionUpdate(ctx, userId, id, input, authority);
  return scanningSessionDetailForAuthority(ctx, id, row.mode, countAuthority);
}

/** The write of a session change, for a console session or a key; returns the session as it was. */
export async function applyScanningSessionUpdate(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  input: z.infer<typeof UpdateScanningSessionSchema>,
  authority: TenantPassWrite,
) {
  const row = await loadScanningSession(ctx, id, authority.mode, authority.orgId);
  if (input.revision !== undefined && input.revision !== row.updated_at)
    throw new ConflictError(
      'This session changed. Reload its settings and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  const attached = acceptedTemplateIds(row.accepts);
  const accepted =
    input.accepts === undefined
      ? undefined
      : input.accepts === null
        ? null
        : await checkAccepts(ctx, row.org_id, row.mode, input.accepts, attached);
  const settingsChanged = input.settings !== undefined || input.accepts !== undefined;
  const previousSettings = settingsChanged ? effectiveSessionSettings(row) : null;
  if (settingsChanged && !previousSettings)
    throw new ValidationError(
      'Correct this scanning session’s settings in Scanning.',
      [],
      'SCANNING_SESSION_SETTINGS_INVALID',
    );
  const zoneCount = input.zoneIds
    ? input.zoneIds.length
    : (await sessionZoneIds(ctx.env.DB, row.org_id, id)).length;
  const settings = settingsChanged
    ? savedOfflineSettings(
        ScanningSessionSettingsSchema.parse({
          ...storedCustomer(row.settings),
          ...previousSettings,
          ...input.settings,
          acceptAllTemplates:
            input.accepts === undefined
              ? (previousSettings?.acceptAllTemplates ?? false)
              : input.accepts === null,
        }),
        zoneCount,
      )
    : null;
  if (input.settings?.checkIn?.eventId)
    await checkAccepts(ctx, row.org_id, row.mode, { eventId: input.settings.checkIn.eventId });
  const next: ScanningSessionRow = {
    ...row,
    name: input.name ?? row.name,
    status: input.status ?? row.status,
    time_zone: input.timeZone ?? row.time_zone,
    accepts: accepted === undefined ? row.accepts : accepted && admitsJson(accepted.admits),
    settings: settings ? JSON.stringify(settings) : row.settings,
  };
  const eventId = accepted === undefined ? eventOfAccepts(row.accepts) : eventOnly(accepted);
  const zoneChecks = await sessionZoneChecks(ctx, row.org_id, input.zoneIds ?? [], eventId, id);
  if (eventId && input.zoneIds === undefined && accepted !== undefined)
    await assertNoZonesLeft(ctx, row.org_id, id);
  const now = ctx.clock.now();
  const devices = await scanningDeviceRows(ctx.env.DB, row.org_id, id);
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.update',
    actorId,
    authority,
    row.org_id,
    [
      sessionEpoch(id, row.config_epoch),
      ...(input.revision === undefined
        ? []
        : [rowIs('scanning_sessions', id, { updated_at: input.revision }, 'stale')]),
      sessionDevicesAre(id, devices),
      ...eventsOpen([...(accepted?.eventIds ?? []), input.settings?.checkIn?.eventId]),
      ...scopeTemplatesUsable(accepted?.templateIds ?? [], attached),
      ...zoneChecks,
    ],
    SESSION_CODES,
    id,
  );
  addScanningSessionUpdate(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.status === undefined ? {} : { status: input.status }),
      // An ended session lets go of its template, so ending then reopening cannot clash with a newer one.
      ...(input.status === 'ended' ? { setup_template_id: null } : {}),
      ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
      ...(accepted === undefined ? {} : { accepts: next.accepts }),
      ...(settings ? { settings: next.settings } : {}),
      ...timingPatch(row, input, now),
    },
    now,
  );
  if (input.zoneIds) addSessionZones(g, id, input.zoneIds, true);
  addSessionPropagation(
    g,
    next,
    devices,
    {
      settings: settingsChanged,
      timeZone: input.timeZone !== undefined,
      ...(accepted === undefined
        ? {}
        : { accepts: accepted ?? { eventId: null, templateIds: [] } }),
    },
    now,
  );
  g.add(
    audited(g, ctx, {
      orgId: row.org_id,
      ...adminActorOf(authority, actorId),
      action: 'scanning.session_update',
      targetType: 'scanning_session',
      targetId: id,
      detail: { status: next.status },
    }),
  );
  addHoursAudit(g, ctx, row, actorId, input.hours);
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'This session changed. Reload its settings and try again.',
        'SCANNING_SESSION_CHANGED',
      );
    throw error;
  }
  await noteSessionChange(ctx, row, next.status, settings ?? effectiveSessionSettings(row), now);
  await Promise.all(devices.map((d) => kickScreen(ctx, row.org_id, row.mode, d.scanner_id)));
  return row;
}
