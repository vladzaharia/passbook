import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import type {
  ScanDeviceOverrides,
  ScanSurface,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertScanningDeviceStmt } from './repo-scanning-devices.ts';
import { insertScanningSessionStmt } from './repo-scanning-sessions.ts';

export interface DeviceEnrollment {
  sessionId: string;
  surface: ScanSurface | 'auto';
  overrides: ScanDeviceOverrides;
  deviceKey?: string;
}
export function enrollmentStmts(
  ctx: ServiceContext,
  id: string,
  userId: string,
  mode: Mode,
  input: {
    orgId: string;
    name: string;
    deviceRole: 'scan' | 'monitor' | 'customer';
    timeZone: string;
    accepts?: unknown;
    adminUserId?: string;
  },
  settings: ScannerSettings,
  enrollment?: DeviceEnrollment,
) {
  const now = ctx.clock.now();
  const surface =
    enrollment?.surface ??
    (input.deviceRole === 'customer'
      ? 'customer'
      : input.deviceRole === 'monitor'
        ? 'desk'
        : 'phone');
  return [
    ...(enrollment
      ? []
      : [
          insertScanningSessionStmt(
            ctx.env.DB,
            {
              id,
              org_id: input.orgId,
              mode,
              name: input.name,
              status: 'active',
              accepts: input.accepts ? JSON.stringify(input.accepts) : null,
              settings: JSON.stringify(settings),
              time_zone: input.timeZone,
              created_at: now,
              updated_at: now,
            },
            userId,
          ),
        ]),
    insertScanningDeviceStmt(ctx.env.DB, {
      id,
      sessionId: enrollment?.sessionId ?? id,
      orgId: input.orgId,
      mode,
      surface,
      effectiveSurface: surface === 'auto' ? 'phone' : surface,
      overrides: enrollment?.overrides ?? {},
      adminUserId: input.adminUserId,
      deviceKey: enrollment?.deviceKey ?? (input.adminUserId ? id : undefined),
    }),
  ];
}
