import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { reportedCapabilities, roleForSurface, surfaceFor } from '../../../shared/scan-surfaces.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  linkedDeviceRoleStmt,
  reportScanningDeviceStmt,
  scanningDeviceRow,
  sessionWatchIds,
  updateScanningDeviceStmt,
} from './repo-scanning-devices.ts';
import { claimConfigRevisionStmt, scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { eventTemplateIds, getEvent } from './repo-scope.ts';
import { scanningSessionActivity } from './repo-session-activity.ts';
import { deviceDto, sessionDto } from './scanning-session-dto.ts';

export async function sessionActivityFor(ctx: ServiceContext, actor: ScanActor) {
  const rows = actor.scanningSession
    ? await scanningSessionActivity(ctx.env.DB, actor.orgId, actor.scanningSession.id, actor.mode)
    : [];
  return { items: rows.filter((r) => actor.settings.lookup || r.deviceId === actor.scanner?.id) };
}

export async function bindScanningSession(ctx: ServiceContext, actor: ScanActor) {
  if (!actor.scanner) return;
  const parent = await scanningSessionForDevice(ctx.env.DB, actor.orgId, actor.scanner.id);
  if (!parent) return;
  if (parent.mode !== actor.mode)
    throw new ForbiddenError('Open the device in its session’s mode.', 'SCANNING_SESSION_MODE');
  actor.scanningSession = { id: parent.id, status: parent.status, updatedAt: parent.updated_at };
  const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, actor.scanner.id);
  const accepts = parent.accepts
    ? (JSON.parse(parent.accepts) as { eventId?: string; templateIds?: string[] })
    : null;
  const parsed = ScannerSettingsSchema.safeParse({
    ...JSON.parse(parent.settings),
    ...(device ? JSON.parse(device.overrides) : {}),
  });
  if (!parsed.success) {
    ctx.log.error('scanning.settings_invalid', {
      orgId: actor.orgId,
      sessionId: parent.id,
      code: 'SCANNING_SESSION_SETTINGS_INVALID',
    });
    throw new ForbiddenError(
      'Correct this scanning session’s settings in Scanning.',
      'SCANNING_SESSION_SETTINGS_INVALID',
    );
  }
  actor.settings = parsed.data;
  actor.event = accepts?.eventId ? await getEvent(ctx.env.DB, actor.orgId, accepts.eventId) : null;
  actor.templateIds = accepts?.eventId
    ? await eventTemplateIds(ctx.env.DB, actor.orgId, accepts.eventId)
    : (accepts?.templateIds ?? []);
  actor.timeZone = actor.event?.timeZone ?? parent.time_zone;
}
export async function scanWorkspace(ctx: ServiceContext, actor: ScanActor) {
  if (!actor.scanner) return null;
  const [parent, device] = await Promise.all([
    scanningSessionForDevice(ctx.env.DB, actor.orgId, actor.scanner.id),
    scanningDeviceRow(ctx.env.DB, actor.orgId, actor.scanner.id),
  ]);
  if (!parent || !device) return null;
  return { session: await sessionDto(ctx, parent), device: deviceDto(device, ctx.clock.now()) };
}
export async function reportScanDevice(
  ctx: ServiceContext,
  actor: ScanActor,
  raw: ScanDeviceCapabilities,
) {
  const device = actor.scanner
    ? await scanningDeviceRow(ctx.env.DB, actor.orgId, actor.scanner.id)
    : null;
  if (!device) return null;
  const capabilities = reportedCapabilities(raw);
  const effective = surfaceFor(device.surface, capabilities);
  const now = ctx.clock.now();
  try {
    await batch(ctx.env.DB, [
      ...(effective === device.effective_surface
        ? []
        : [claimConfigRevisionStmt(ctx.env.DB, 'device', device.scanner_id, device.updated_at)]),
      reportScanningDeviceStmt(ctx.env.DB, actor.orgId, device.scanner_id, capabilities, now),
      ...(effective === device.effective_surface
        ? []
        : [
            updateScanningDeviceStmt(
              ctx.env.DB,
              actor.orgId,
              device.scanner_id,
              device.surface,
              effective,
              JSON.parse(device.overrides),
            ),
            linkedDeviceRoleStmt(
              ctx.env.DB,
              actor.orgId,
              device.scanner_id,
              roleForSurface(effective),
              Math.max(now, device.updated_at + 1),
            ),
          ]),
    ]);
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
  }
  return scanWorkspace(ctx, actor);
}
export async function sessionScreenWatch(ctx: ServiceContext, orgId: string, scannerId: string) {
  const parent = await scanningSessionForDevice(ctx.env.DB, orgId, scannerId);
  if (!parent || parent.id === scannerId) return null;
  return { scannerIds: await sessionWatchIds(ctx.env.DB, orgId, parent.id), allOrg: false };
}
