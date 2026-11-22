import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type {
  CreateScanningDeviceSchema,
  UpdateScanningDeviceSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { roleForSurface, surfaceFor } from '../../../shared/scan-surfaces.ts';
import { readStoredCapabilities } from '../../../shared/stored-capabilities.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getUser } from '../users/repo.ts';
import { planScanningDevice, scanningDeviceStatements } from './device-statements.ts';
import { kickScreen } from './live.ts';
import {
  adminActorOf,
  adminGrant,
  audited,
  scannerEpoch,
  sessionEpoch,
} from './repo-admin-grant.ts';
import { assertAdminConfigurationAuthority } from './repo-scanner-configuration-authority.ts';
import { addScannerPatch, getConsoleScanner } from './repo-scanners.ts';
import {
  addLinkedDeviceRole,
  addScanningDeviceUpdate,
  adminScanningDevice,
  scanningDeviceRow,
} from './repo-scanning-devices.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  conflictsWithAllScope,
  deviceDto,
  effectiveSessionSettings,
  projectedDeviceSettings,
  resolveSessionScope,
} from './scanning-session-dto.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import { newCapture, slotChecks } from './setup-capture.ts';
import { issuePairing, SETUP_CODES, setupConflict } from './setup-statements.ts';

export { revokeScanner } from './scanning-device-revocation.ts';

const DEVICE_CODES = {
  config: 'SCANNING_DEVICE_CHANGED',
  lineage: 'SCANNING_DEVICE_CHANGED',
  stale: 'SCANNING_DEVICE_CHANGED',
} as const;

export async function createScanningDevice(
  ctx: ServiceContext,
  userId: string,
  _mode: Mode,
  sessionId: string,
  input: z.infer<typeof CreateScanningDeviceSchema>,
  origin: string,
  authority: TenantPassWrite,
  admin?: { userId: string; deviceKey: string },
) {
  const parent = await loadScanningSession(ctx, sessionId);
  const capture = newCapture({
    userId,
    authority,
    orgId: parent.org_id,
    mode: parent.mode,
    origin,
  });
  const { plan, scope } = await planScanningDevice(ctx, parent, input, capture, admin, false);
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.create',
    userId,
    authority,
    parent.org_id,
    [...slotChecks(capture), ...plan.checks],
    SETUP_CODES,
    plan.id,
  );
  const made = scanningDeviceStatements(g, ctx, plan, capture);
  try {
    await g.commit();
  } catch (error) {
    setupConflict(error);
  }
  const pairing = await issuePairing(ctx, capture, plan.input, made.id);
  const row = await scanningDeviceRow(ctx.env.DB, parent.org_id, made.id);
  if (!row) throw new NotFoundError('Device not found.', 'SCANNING_DEVICE_NOT_FOUND');
  return {
    ...deviceDto(row, ctx.clock.now(), projectedDeviceSettings(parent, row, scope)),
    pairing,
  };
}
export async function updateScanningDevice(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  id: string,
  input: z.infer<typeof UpdateScanningDeviceSchema>,
  authority: TenantPassWrite,
) {
  const parent = await loadScanningSession(ctx, sessionId);
  const device = await scanningDeviceRow(ctx.env.DB, parent.org_id, id);
  if (!device || device.session_id !== sessionId || device.revoked_at !== null)
    throw new NotFoundError('Device not found.', 'SCANNING_DEVICE_NOT_FOUND');
  if (input.revision !== undefined && input.revision !== device.updated_at)
    throw new ConflictError(
      'This device changed. Reload its settings and try again.',
      'SCANNING_DEVICE_CHANGED',
    );
  const scanner = await getConsoleScanner(ctx.env.DB, id);
  if (!scanner || scanner.updatedAt !== device.updated_at || scanner.mode !== parent.mode)
    throw new ConflictError(
      'This device changed. Reload its settings and try again.',
      'SCANNING_DEVICE_CHANGED',
    );
  const surface = input.surface ?? device.surface;
  const caps =
    input.surface !== undefined
      ? readStoredCapabilities(device.capabilities, (issue) =>
          ctx.log.warn('scan.device_caps_unreadable', {
            code: 'SCAN_DEVICE_CAPS_UNREADABLE',
            issue,
          }),
        )
      : null;
  const effective =
    input.surface === undefined ? device.effective_surface : surfaceFor(surface, caps);
  if (
    input.surface !== undefined &&
    device.kind === 'terminal' &&
    roleForSurface(effective) !== 'scan'
  )
    throw new ValidationError(
      'A terminal cannot be used as a display.',
      [],
      'SCAN_SURFACE_UNSUPPORTED',
    );
  const overrides = input.overrides ?? JSON.parse(device.overrides);
  const scope = await resolveSessionScope(ctx, parent);
  const parentSettings = input.overrides === undefined ? null : effectiveSessionSettings(parent);
  if (input.overrides !== undefined && !parentSettings)
    throw new ValidationError(
      'Correct this scanning session’s settings first.',
      [],
      'SCANNING_SESSION_SETTINGS_INVALID',
    );
  const settings = parentSettings
    ? ScannerSettingsSchema.parse({
        ...parentSettings,
        ...overrides,
        ...(scope.restricted ? { acceptAllTemplates: false } : {}),
      })
    : null;
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.device.update',
    userId,
    authority,
    parent.org_id,
    [
      scannerEpoch(id, scanner.configEpoch),
      sessionEpoch(parent.id, parent.config_epoch),
      ...(input.revision === undefined
        ? []
        : [rowIs('scanners', id, { updated_at: input.revision }, 'stale')]),
    ],
    DEVICE_CODES,
    id,
  );
  if (input.surface !== undefined || input.overrides !== undefined)
    addScanningDeviceUpdate(g, id, surface, effective, overrides);
  addScannerPatch(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(settings ? { settings: JSON.stringify(settings) } : {}),
    },
    now,
  );
  if (input.surface !== undefined)
    addLinkedDeviceRole(g, id, scanner.kind, roleForSurface(effective), now);
  g.add(
    audited(g, ctx, {
      orgId: parent.org_id,
      ...adminActorOf(authority, userId),
      action: 'scanning.device_update',
      targetType: 'scanner',
      targetId: id,
      detail: { surface },
    }),
  );
  try {
    await g.commit();
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
  const nextSettings = projectedDeviceSettings(parent, next, scope);
  const scannerScope = await readScannerScope(ctx.env.DB, scanner, null);
  const conflict = await conflictsWithAllScope(ctx, scanner, scope, nextSettings);
  const view = deviceDto(
    next,
    ctx.clock.now(),
    !scannerScope.valid || conflict ? { ...nextSettings, acceptAllTemplates: false } : nextSettings,
  );
  // Keys get ids, not the admin's name.
  return authority.kind === 'api_key' ? { ...view, adminName: null } : view;
}
export async function joinAdminScanningSession(
  ctx: ServiceContext,
  userId: string,
  _mode: Mode,
  input: { sessionId: string; deviceKey: string },
  origin: string,
  authority: TenantPassWrite,
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
        authority,
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
  await assertAdminConfigurationAuthority(ctx.env.DB, parent.org_id, {
    kind: 'admin',
    userId,
    authority,
    now: ctx.clock.now(),
  });
  return { setupId: id, orgId: parent.org_id, mode: parent.mode, timeZone: parent.time_zone };
}
