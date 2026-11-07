import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';

/** Old device URLs remain editable only while they represent a standalone session. */
export async function assertStandaloneSession(
  ctx: ServiceContext,
  orgId: string,
  scannerId: string,
) {
  const parent = await scanningSessionForDevice(ctx.env.DB, orgId, scannerId);
  if (
    parent &&
    (parent.id !== scannerId || (await scanningDeviceRows(ctx.env.DB, orgId, parent.id)).length > 1)
  )
    throw new ConflictError(
      'Configure this device from its scanning session.',
      'SCANNING_SESSION_CONFIG_REQUIRED',
    );
}
