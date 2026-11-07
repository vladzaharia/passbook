import {
  ScanDeviceCapabilitiesSchema,
  ScanningDeviceSchema,
  ScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { localDayStart } from './counts.ts';
import { parseSettings } from './dto-console.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionStats } from './repo-scanning-sessions.ts';

export const deviceDto = (row: ScanningDeviceRow, now: number) =>
  ScanningDeviceSchema.parse({
    id: row.scanner_id,
    sessionId: row.session_id,
    name: row.name,
    surface: row.surface,
    effectiveSurface: row.effective_surface,
    overrides: JSON.parse(row.overrides),
    settings: parseSettings(row.settings),
    capabilities: row.capabilities
      ? ScanDeviceCapabilitiesSchema.parse(JSON.parse(row.capabilities))
      : null,
    reportedAt: row.reported_at,
    paired: !!row.token_hash || !!row.admin_user_id,
    online:
      row.revoked_at === null && row.last_seen_at !== null && now - row.last_seen_at < 120_000,
    revoked: row.revoked_at !== null,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    signIn: row.admin_user_id ? 'admin' : 'paired',
    adminName: row.admin_user_id ? row.admin_name : null,
  });
export async function sessionDto(ctx: ServiceContext, row: ScanningSessionRow) {
  const now = ctx.clock.now();
  const stats = await scanningSessionStats(
    ctx.env.DB,
    row.org_id,
    row.id,
    localDayStart(now, row.time_zone),
    now - 120_000,
  );
  return ScanningSessionSchema.parse({
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    mode: row.mode,
    name: row.name,
    status: row.status,
    accepts: row.accepts ? JSON.parse(row.accepts) : null,
    settings: parseSettings(row.settings),
    timeZone: row.time_zone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deviceCount: stats?.devices ?? 0,
    onlineCount: stats?.online ?? 0,
    today: stats?.today ?? 0,
  });
}
