import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { roleForSurface, surfaceFor } from '../../../shared/scan-surfaces.ts';
import { grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScanActor, withRole } from './actor.ts';
import { captureScanEpochs, scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import {
  addLinkedDeviceRole,
  addScanningDeviceUpdate,
  reportedCapabilitiesStmt,
} from './repo-scanning-devices.ts';
import { getStaff } from './repo-staff.ts';
import type { ObservedScanningSessionSnapshot } from './scanning-workspace-observation.ts';

const REPORT_CODES = {
  config: 'SCANNING_DEVICE_CHANGED',
  lineage: 'SCANNING_DEVICE_CHANGED',
} as const;

const changed = () =>
  new ConflictError('This device changed. Reload and try again.', 'SCANNING_DEVICE_CHANGED');

/**
 * Persist a device report under the actor's grant. The grant is the check: once it commits the
 * report is done, and nothing below it can turn that into a 409. A report that loses a race to a
 * configuration edit is refused before it writes (409, and the device refetches).
 */
export async function commitReportedDevice(
  ctx: ServiceContext,
  actor: ScanActor,
  observed: ObservedScanningSessionSnapshot,
  capabilities: ScanDeviceCapabilities,
  bindScanningSession: (ctx: ServiceContext, actor: ScanActor) => Promise<void>,
): Promise<void> {
  const old = actor.scanner;
  if (!old) throw changed();
  const { device } = observed;
  const legacyStandaloneDesk = device.surface === 'desk' && device.session_id === device.scanner_id;
  const effective = legacyStandaloneDesk ? 'desk' : surfaceFor(device.surface, capabilities);
  const surfaceChanged = effective !== device.effective_surface;
  const now = ctx.clock.now();
  const g = grant(ctx, {
    purpose: 'org_mode.scan.device.report',
    principal: scanPrincipal(actor),
    checks: [
      ...scanActorChecks(actor, { now }),
      exactlyOne(
        'scanning_devices',
        { scanner_id: device.scanner_id, session_id: device.session_id },
        undefined,
        'config',
      ),
    ],
    target: device.scanner_id,
    codes: REPORT_CODES,
  });
  reportedCapabilitiesStmt(g, device.scanner_id, capabilities, now);
  if (surfaceChanged) {
    addScanningDeviceUpdate(
      g,
      device.scanner_id,
      device.surface,
      effective,
      JSON.parse(device.overrides),
    );
    addLinkedDeviceRole(g, device.scanner_id, old.kind, roleForSurface(effective), now);
  }
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique') throw changed();
    throw error;
  }
  // Committed. Refresh the actor from the rows; only a credential that moved on ends the session.
  const updated = await getScanner(ctx.env.DB, old.id);
  if (!updated || updated.revokedAt !== null || updated.tokenHash !== old.tokenHash)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  // The row as committed, secret-free: anything else (a rename elsewhere) is just the current state.
  actor.scanner = Object.defineProperties(
    { ...updated, csrfSecret: null },
    {
      credentialEpoch: { value: updated.credentialEpoch, enumerable: false },
      configEpoch: { value: updated.configEpoch, enumerable: false },
    },
  );
  // The report moved the scanner's configuration epoch: the actor is re-derived and re-captured, so
  // the answer is built from the committed state rather than refused for the actor's own write.
  for (let attempt = 0; ; attempt++) {
    delete actor.scanningSession;
    await bindScanningSession(ctx, actor);
    const staff = actor.staff ? await getStaff(ctx.env.DB, actor.orgId, actor.staff.id) : null;
    try {
      await captureScanEpochs(ctx.env.DB, actor, scannerEpochsOf(updated), staff?.pinHash);
      break;
    } catch (error) {
      // A racing edit after the commit: derive once more from the newest rows.
      if (!(error instanceof ConflictError) || attempt >= 1) throw error;
    }
  }
  if (actor.principal === 'scanner')
    withRole(actor, actor.settings.staffSignIn ? actor.staff : null);
}
