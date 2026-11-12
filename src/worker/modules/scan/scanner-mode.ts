import type { z } from 'zod';
import { type ScannerModeSchema, ScannerSettingsSchema } from '../../../shared/contracts/index.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertStandaloneSession } from './legacy-session.ts';
import { kickScreen } from './live.ts';
import { adminGrant, audited, scannerEpoch, sessionEpoch } from './repo-admin-grant.ts';
import { assertAdminConfigurationAuthority } from './repo-scanner-configuration-authority.ts';
import { addScannerPatchSessionSync } from './repo-scanner-configuration-sync.ts';
import { addScannerMode } from './repo-scanners.ts';
import { addDeviceModeSync, scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { adminSetupId, setupMeta, watchedScanners, watchOf } from './repo-setups.ts';
import { nameTaken } from './scanner-name.ts';
import { loadScanner, scannerView } from './scanner-views.ts';
import { SCANNER_CODES } from './scanners.ts';

/** Go live / Move to Test mode. The token stays; the credential epoch moves with the mode. */
export async function changeMode(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof ScannerModeSchema>,
  authority: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id, authority.mode);
  if (row.mode === input.mode) {
    await assertAdminConfigurationAuthority(db, row.orgId, {
      kind: 'admin',
      userId,
      authority,
      now: ctx.clock.now(),
    });
    return scannerView(ctx, id);
  }
  await assertStandaloneSession(ctx, row.orgId, id);
  const meta = await setupMeta(db, row.orgId, id);
  if (meta?.admin_user_id && (await adminSetupId(db, row.orgId, input.mode, meta.admin_user_id)))
    throw new ConflictError(
      'Use the existing admin setup in that mode.',
      'SCANNER_ADMIN_SETUP_EXISTS',
    );
  const watch = watchOf(meta);
  if (
    row.deviceRole !== 'scan' &&
    watch &&
    !watch.allOrg &&
    (await watchedScanners(db, row.orgId, input.mode, watch.scannerIds)).length !==
      new Set(watch.scannerIds).size
  )
    throw new ValidationError(
      'Move the watched scanners to that mode first.',
      [],
      'SCANNER_WATCH_MODE',
    );
  const detach = row.eventId !== null;
  if (detach && !input.detachEvent)
    throw new ValidationError(
      'This event is in a different mode than the scanner.',
      [],
      'SCAN_MODE_MISMATCH',
    );
  const [device, parent] = await Promise.all([
    scanningDeviceRow(db, row.orgId, id),
    scanningSessionForDevice(db, row.orgId, id),
  ]);
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org.scan.scanner.mode',
    userId,
    authority,
    row.orgId,
    [
      scannerEpoch(id, row.configEpoch),
      exactlyOne('scanners', { id, mode: authority.mode }, undefined, 'config'),
      ...(parent ? [sessionEpoch(parent.id, parent.config_epoch)] : []),
    ],
    SCANNER_CODES,
    id,
  );
  // Events belong to a mode: a check-in policy pinned to one cannot follow the scanner across.
  const parsed = ScannerSettingsSchema.safeParse(JSON.parse(row.settings));
  const cleared =
    parsed.success && parsed.data.checkIn?.eventId
      ? JSON.stringify({ ...parsed.data, checkIn: { ...parsed.data.checkIn, eventId: null } })
      : undefined;
  addScannerMode(g, id, input.mode, detach, now, cleared);
  if (device) {
    addDeviceModeSync(g, id, input.mode);
    addScannerPatchSessionSync(
      g,
      id,
      {
        mode: input.mode,
        ...(detach ? { accepts: null } : {}),
        ...(cleared === undefined ? {} : { settings: cleared }),
      },
      now,
    );
  }
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.mode_change',
      targetType: 'scanner',
      targetId: id,
      detail: { from: row.mode, to: input.mode, detachedEvent: detach },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    nameTaken(error);
  }
  if (row.deviceRole !== 'scan') await kickScreen(ctx, row.orgId, row.mode, id);
  return scannerView(ctx, id);
}
