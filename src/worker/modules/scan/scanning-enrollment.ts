import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import { type AdmitsInput, admitsOf } from '../../../shared/contracts/scanners.ts';
import type { ScanDeviceOverrides } from '../../../shared/contracts/scanning-sessions.ts';
import type { StoredSurface } from '../../../shared/scan-surfaces.ts';
import type { Grant } from '../../platform/authority.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { admitsJson } from './admits.ts';
import { addScanningDeviceInsert } from './repo-scanning-devices.ts';
import { addScanningSessionInsert } from './repo-scanning-sessions.ts';

export interface DeviceEnrollment {
  sessionId: string;
  surface: StoredSurface;
  overrides: ScanDeviceOverrides;
  deviceKey?: string;
}

/** A standalone scanner gets its own session; every scanner gets its device row. */
export function addEnrollment(
  ctx: ServiceContext,
  g: Grant,
  id: string,
  createdBy: string | null,
  input: {
    name: string;
    deviceRole: 'scan' | 'monitor' | 'customer';
    timeZone: string;
    accepts?: AdmitsInput | null;
    adminUserId?: string;
  },
  settings: ScannerSettings,
  enrollment?: DeviceEnrollment,
): void {
  const now = ctx.clock.now();
  const surface =
    enrollment?.surface ??
    (input.deviceRole === 'customer'
      ? 'customer'
      : input.deviceRole === 'monitor'
        ? 'desk'
        : 'phone');
  if (!enrollment)
    addScanningSessionInsert(
      g,
      {
        id,
        name: input.name,
        status: 'active',
        accepts: input.accepts ? admitsJson(admitsOf(input.accepts)) : null,
        settings: JSON.stringify(settings),
        time_zone: input.timeZone,
        hours: null,
        hours_next_at: null,
        created_at: now,
        updated_at: now,
      },
      createdBy,
    );
  addScanningDeviceInsert(g, {
    id,
    sessionId: enrollment?.sessionId ?? id,
    surface,
    effectiveSurface: surface === 'auto' ? 'phone' : surface,
    overrides: enrollment?.overrides ?? {},
    adminUserId: input.adminUserId,
    deviceKey: enrollment?.deviceKey ?? (input.adminUserId ? id : undefined),
  });
}
