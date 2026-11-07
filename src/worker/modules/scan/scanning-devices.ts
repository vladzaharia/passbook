import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import {
  type CreateScanningDeviceSchema,
  ScanDeviceCapabilitiesSchema,
  type UpdateScanningDeviceSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { roleForSurface, surfaceFor } from '../../../shared/scan-surfaces.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { getUser } from '../users/repo.ts';
import { parseSettings } from './dto-console.ts';
import { kickScreen } from './live.ts';
import { updateScannerStmt } from './repo-scanners.ts';
import {
  adminScanningDevice,
  linkedDeviceRoleStmt,
  scanningDeviceRow,
  scanningDeviceRows,
  updateScanningDeviceStmt,
} from './repo-scanning-devices.ts';
import { claimConfigRevisionStmt } from './repo-scanning-sessions.ts';
import { deviceDto } from './scanning-session-dto.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import { createSetup } from './setups.ts';

export async function createScanningDevice(
  ctx: ServiceContext,
  userId: string,
  _mode: Mode,
  sessionId: string,
  input: z.infer<typeof CreateScanningDeviceSchema>,
  origin: string,
  admin?: { userId: string; deviceKey: string },
) {
  const parent = await loadScanningSession(ctx, sessionId);
  if (parent.status !== 'active')
    throw new ConflictError(
      'Resume the scanning session before adding devices.',
      'SCANNING_SESSION_PAUSED',
    );
  const devices = await scanningDeviceRows(ctx.env.DB, parent.org_id, sessionId);
  if (devices.filter((d) => d.revoked_at === null).length >= 64)
    throw new ValidationError('This session already has 64 devices. Remove an unused device.');
  const settings = ScannerSettingsSchema.parse({
    ...parseSettings(parent.settings),
    ...input.overrides,
  });
  const made = await createSetup(
    ctx,
    userId,
    parent.mode,
    {
      orgId: parent.org_id,
      name: input.name,
      kind: 'device',
      deviceRole: roleForSurface(input.surface),
      accepts: parent.accepts ? JSON.parse(parent.accepts) : null,
      settings,
      timeZone: parent.time_zone,
      watch: roleForSurface(input.surface) === 'scan' ? null : { scannerIds: [], allOrg: false },
      ...(admin ? { adminUserId: admin.userId } : {}),
    },
    origin,
    { sessionId, surface: input.surface, overrides: input.overrides, deviceKey: admin?.deviceKey },
  );
  const row = await scanningDeviceRow(ctx.env.DB, parent.org_id, made.id);
  if (!row) throw new NotFoundError('Device not found.', 'SCANNING_DEVICE_NOT_FOUND');
  return { ...deviceDto(row, ctx.clock.now()), pairing: made.pairing };
}
export async function updateScanningDevice(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  id: string,
  input: z.infer<typeof UpdateScanningDeviceSchema>,
) {
  const parent = await loadScanningSession(ctx, sessionId);
  const device = await scanningDeviceRow(ctx.env.DB, parent.org_id, id);
  if (input.revision !== undefined && device && input.revision !== device.updated_at)
    throw new ConflictError(
      'This device changed. Reload its settings and try again.',
      'SCANNING_DEVICE_CHANGED',
    );
  if (!device || device.session_id !== sessionId || device.revoked_at !== null)
    throw new NotFoundError('Device not found.', 'SCANNING_DEVICE_NOT_FOUND');
  const caps = device.capabilities
    ? ScanDeviceCapabilitiesSchema.parse(JSON.parse(device.capabilities))
    : null;
  if (
    input.surface &&
    input.surface !== 'auto' &&
    input.surface !== device.surface &&
    caps &&
    !caps.surfaces.includes(input.surface)
  )
    throw new ValidationError(
      'Choose a layout supported by this device’s current screen.',
      [],
      'SCAN_SURFACE_UNSUPPORTED',
    );
  const surface = input.surface ?? device.surface;
  const effective = surfaceFor(surface, caps);
  if (device.kind === 'terminal' && roleForSurface(effective) !== 'scan')
    throw new ValidationError(
      'A terminal cannot be used as a display.',
      [],
      'SCAN_SURFACE_UNSUPPORTED',
    );
  const overrides = input.overrides ?? JSON.parse(device.overrides);
  const settings = ScannerSettingsSchema.parse({ ...parseSettings(parent.settings), ...overrides });
  const now = Math.max(ctx.clock.now(), device.updated_at + 1);
  try {
    await batch(ctx.env.DB, [
      claimConfigRevisionStmt(ctx.env.DB, 'device', id, device.updated_at),
      updateScanningDeviceStmt(ctx.env.DB, parent.org_id, id, surface, effective, overrides),
      updateScannerStmt(
        ctx.env.DB,
        id,
        { name: input.name ?? device.name, settings: JSON.stringify(settings) },
        now,
      ),
      linkedDeviceRoleStmt(ctx.env.DB, parent.org_id, id, roleForSurface(effective), now),
      auditStmt(ctx.env.DB, ctx, {
        orgId: parent.org_id,
        actorType: 'user',
        actorId: userId,
        action: 'scanning.device_update',
        targetType: 'scanner',
        targetId: id,
        detail: { surface },
      }),
    ]);
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'This device changed or its name is already in use. Reload its settings and try again.',
        'SCANNING_DEVICE_CHANGED',
      );
    throw error;
  }
  await kickScreen(ctx, parent.org_id, parent.mode, id);
  const next = await scanningDeviceRow(ctx.env.DB, parent.org_id, id);
  if (!next) throw new NotFoundError('Device not found.', 'SCANNING_DEVICE_NOT_FOUND');
  return deviceDto(next, ctx.clock.now());
}
export async function joinAdminScanningSession(
  ctx: ServiceContext,
  userId: string,
  _mode: Mode,
  input: { sessionId: string; deviceKey: string },
  origin: string,
) {
  const parent = await loadScanningSession(ctx, input.sessionId);
  const existing = await adminScanningDevice(
    ctx.env.DB,
    parent.org_id,
    parent.id,
    userId,
    input.deviceKey,
  );
  if (parent.status !== 'active')
    throw new ConflictError(
      'Resume the scanning session before joining.',
      'SCANNING_SESSION_PAUSED',
    );
  let id = existing?.scanner_id;
  if (!id) {
    const user = await getUser(ctx.env.DB, userId);
    const suffix = ctx.ids.id().slice(-6);
    try {
      const made = await createScanningDevice(
        ctx,
        userId,
        parent.mode,
        parent.id,
        {
          name: `${(user?.name ?? 'Administrator').slice(0, 31)} · ${suffix}`,
          surface: 'auto',
          overrides: {},
        },
        origin,
        { userId, deviceKey: input.deviceKey },
      );
      id = made.id;
    } catch (error) {
      const concurrent =
        error instanceof ConflictError
          ? await adminScanningDevice(ctx.env.DB, parent.org_id, parent.id, userId, input.deviceKey)
          : null;
      if (!concurrent) throw error;
      id = concurrent.scanner_id;
    }
  }
  return { setupId: id, orgId: parent.org_id, mode: parent.mode, timeZone: parent.time_zone };
}
