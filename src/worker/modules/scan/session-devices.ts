import type { SessionDevices } from '../../../shared/contracts/scanning-session-devices.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { scanHub } from './live.ts';
import { scanningSessionDevices } from './repo-session-devices.ts';
import { resolveSessionScope } from './scanning-session-dto.ts';
import { scanSessionCountAuthority } from './scanning-workspace.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';

/** Contact this recent counts as online for a device with no hub socket. */
export const DEVICE_ONLINE_MS = 120_000;

/**
 * The session's scanners and whether each is connected, under the device's own fence. A Door sees
 * none: names of other devices are for the roles that supervise them.
 */
export async function sessionDevicesFor(
  context: ServiceContext,
  sourceActor: ScanActor,
): Promise<SessionDevices> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  const observed = actor.scanningSession ? captureObservedScanningSession(actor) : null;
  if (!actor.role || (actor.scanningSession && !observed))
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  if (actor.invalidScannerScope || !observed) return { items: [] };
  // As /activity: a session whose scope no longer resolves is stale, not empty.
  if (!(await resolveSessionScope(ctx, observed.parent)).valid)
    throw await staleScanRead(ctx, sourceActor);
  const now = ctx.clock.now();
  const rows = await scanningSessionDevices(
    ctx.env.DB,
    observed.parent,
    scanSessionCountAuthority(actor),
    now,
  );
  if (rows === null) throw await staleScanRead(ctx, sourceActor);
  if (actor.role === 'door') return { items: [] };
  let connected = new Set<string>();
  try {
    connected = new Set(
      await scanHub(ctx, actor.orgId, actor.mode).connected(rows.map((r) => r.id)),
    );
  } catch {
    ctx.log.warn('scan.devices_presence_failed', {
      orgId: actor.orgId,
      code: 'SCAN_DEVICES_PRESENCE_FAILED',
    });
  }
  return {
    items: rows.map((r) => ({
      ...r,
      online:
        connected.has(r.id) || (r.lastSeenAt !== null && now - r.lastSeenAt <= DEVICE_ONLINE_MS),
      self: r.id === actor.scanner?.id,
    })),
  };
}
