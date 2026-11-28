import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type { UpdateScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { roleOfStoredSurface } from '../../../shared/scan-surfaces.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { admitsJson } from './admits.ts';
import { assertStandaloneSession } from './legacy-session.ts';
import { kickScreen } from './live.ts';
import {
  adminGrant,
  audited,
  eventsOpen,
  scannerEpoch,
  scopeTemplatesUsable,
  sessionEpoch,
} from './repo-admin-grant.ts';
import { addSetupWatch, replaceScannerTemplates } from './repo-admin-unguarded.ts';
import { addScannerPatchSessionSync } from './repo-scanner-configuration-sync.ts';
import { addScannerPatch } from './repo-scanners.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { addDeviceRole, addSetupAcceptsClear, setupMeta, watchOf } from './repo-setups.ts';
import { checkAccepts, requireScannerSettings } from './scanner-validation.ts';
import { loadScanner } from './scanner-views.ts';
import type { DeviceEnrollment } from './scanning-enrollment.ts';
import { newCapture, slotChecks } from './setup-capture.ts';
import {
  type CreateSetup,
  issuePairing,
  planSetup,
  roleAllowed,
  SETUP_CODES,
  setupConflict,
  setupStatements,
} from './setup-statements.ts';
import { setupView } from './setup-views.ts';
import { checkWatch } from './setup-watch.ts';

type Update = z.infer<typeof UpdateScannerSetupSchema>;

export async function createSetup(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: CreateSetup,
  origin: string,
  authority: TenantPassWrite,
  enrollment?: DeviceEnrollment,
  parent?: ScanningSessionRow,
) {
  const capture = newCapture({ userId, authority, orgId: input.orgId, mode, origin });
  const plan = await planSetup(ctx, input, capture, enrollment, parent, false);
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.create',
    userId,
    authority,
    input.orgId,
    [...slotChecks(capture), ...plan.checks],
    SETUP_CODES,
    plan.id,
  );
  const { id } = setupStatements(g, ctx, plan, capture);
  try {
    await g.commit();
  } catch (error) {
    setupConflict(error);
  }
  const pairing = await issuePairing(ctx, capture, input, id);
  return { ...(await setupView(ctx, id)), pairing };
}

export async function updateSetup(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: Update,
  authority: TenantPassWrite,
) {
  const row = await loadScanner(ctx, id, authority.mode);
  await assertStandaloneSession(ctx, row.orgId, id);
  const [device, parent] = await Promise.all([
    scanningDeviceRow(ctx.env.DB, row.orgId, id),
    scanningSessionForDevice(ctx.env.DB, row.orgId, id),
  ]);
  if (!!device !== !!parent || (parent && parent.id !== id))
    throw new ConflictError(
      'This scanner changed. Reload its settings and try again.',
      'SCANNER_CHANGED',
    );
  const role = input.deviceRole ?? row.deviceRole;
  if (
    device &&
    input.deviceRole !== undefined &&
    input.deviceRole !== roleOfStoredSurface(device.surface)
  )
    throw new ValidationError('The kind of device cannot change.', [], 'DEVICE_KIND_FIXED');
  const changingWatch = input.deviceRole !== undefined || input.watch !== undefined;
  const meta = changingWatch ? await setupMeta(ctx.env.DB, row.orgId, id) : null;
  const watch = input.watch === undefined ? watchOf(meta) : input.watch;
  if (input.deviceRole !== undefined) roleAllowed(row.kind, role);
  if (changingWatch) await checkWatch(ctx, row.orgId, row.mode, role, watch, id);
  const accepts = input.accepts
    ? await checkAccepts(ctx, row.orgId, row.mode, input.accepts, row.templateIds)
    : null;
  const settings =
    input.settings !== undefined || input.accepts !== undefined
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(row.settings),
          ...input.settings,
          ...(input.accepts === undefined ? {} : { acceptAllTemplates: input.accepts === null }),
        })
      : null;
  const parentSettings =
    parent && settings
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(parent.settings),
          ...input.settings,
          ...(input.accepts === undefined ? {} : { acceptAllTemplates: input.accepts === null }),
        })
      : null;
  if (input.settings?.checkIn?.eventId)
    await checkAccepts(ctx, row.orgId, row.mode, { eventId: input.settings.checkIn.eventId });
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.update',
    userId,
    authority,
    row.orgId,
    [
      scannerEpoch(id, row.configEpoch),
      ...(parent ? [sessionEpoch(parent.id, parent.config_epoch)] : []),
      ...eventsOpen([...(accepts?.eventIds ?? []), input.settings?.checkIn?.eventId]),
      ...scopeTemplatesUsable(accepts?.templateIds ?? [], row.templateIds),
    ],
    SETUP_CODES,
    id,
  );
  addScannerPatch(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(settings ? { settings: JSON.stringify(settings) } : {}),
      ...(accepts ? { eventId: accepts.eventId } : {}),
    },
    now,
  );
  if (input.deviceRole !== undefined) addDeviceRole(g, id, row.deviceRole, role, now);
  if (input.accepts === null) addSetupAcceptsClear(g, id, now);
  if (input.accepts !== undefined) replaceScannerTemplates(g, id, accepts?.templateIds ?? []);
  if (changingWatch) addSetupWatch(g, id, role === 'scan' ? null : watch);
  if (parent)
    addScannerPatchSessionSync(
      g,
      id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(parentSettings ? { settings: JSON.stringify(parentSettings) } : {}),
        ...(input.accepts === undefined
          ? {}
          : { accepts: accepts ? admitsJson(accepts.admits) : null }),
      },
      now,
    );
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.setup_update',
      targetType: 'scanner',
      targetId: id,
      detail: { deviceRole: role },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    setupConflict(error);
  }
  await kickScreen(ctx, row.orgId, row.mode, id);
  return setupView(ctx, id);
}
